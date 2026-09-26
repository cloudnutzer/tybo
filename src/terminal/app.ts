/**
 * Chat im Terminal (Issue #60): verbindet ChatSession mit dem Terminal.
 *
 * Zwei Betriebsarten:
 * - Voll (TTY an Ein- und Ausgabe, Farbe erlaubt): Raw-Modus mit eigenem
 *   Editor (Mehrzeilen, Verlauf), unten Statuszeile und Eingabe, die bei
 *   jeder neuen Nachricht darunter neu gezeichnet werden.
 * - Schlicht (NO_COLOR, TERM=dumb oder kein TTY): keine einzige
 *   Escape-Sequenz. Eingabe zeilenweise über das Terminal selbst oder eine
 *   Pipe, \ am Zeilenende für mehrzeilig, Status als eigene Zeilen.
 *   Aus einer Pipe (echo "Frage" | tybo) wartet tybo die Antworten ab
 *   und endet danach.
 *
 * Kein Vollbild, keine Fenster (Nicht-Ziel): Nachrichten laufen wie in
 * einer Shell nach oben weg.
 */

import { BRAND } from "../brand";
import type { ApiClient, ConversationSummary, Message } from "./api";
import { CommandRunner } from "./command-runner";
import { completeInput, parseChoiceNumber, parseInput, type ParsedInput } from "./commands";
import { InterruptGate, KeyDecoder, LineEditor } from "./editor";
import type { LiveOptions } from "./live";
import { createStyle, displayWidth, stripStyle, wantsColor, type Style } from "./render";
import { sanitizeLine } from "./sanitize";
import { ChatSession } from "./session";
import { choiceOptionsText, choiceStatusText, formatMessage, headerLine, hintLine } from "./view";

type Env = Record<string, string | undefined>;

export interface TerminalInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface TerminalOutput {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

export interface ChatAppOptions {
  client: ApiClient;
  conversation: ConversationSummary;
  /** Hinweis aus der Gesprächswahl (z. B. gespeichertes Gespräch gelöscht) */
  note?: string;
  stdin: TerminalInput;
  stdout: TerminalOutput;
  env: Env;
  /** Signale anmelden; gibt die Abmeldung zurück (Standard: process.on) */
  onSignal?(signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void): () => void;
  ctrlCWindowMs?: number;
  now?: () => number;
  live?: LiveOptions;
  /** Abstand der Laufzeit-Aktualisierung in der Statuszeile, Standard 1 s */
  tickMs?: number;
  /** Nach /wechsel oder /neu: neue Auswahl merken (scripts/tybo.ts schreibt state.json) */
  onSwitch?(conversation: ConversationSummary): Promise<unknown> | void;
}

/**
 * Was runChatApp am Terminal eingeschaltet und noch nicht zurückgestellt
 * hat. Der Exit-Handler in scripts/tybo.ts räumt bei einem Absturz nur
 * das auf; mit NO_COLOR oder TERM=dumb bleibt so auch das Beenden ohne
 * Escape-Sequenz.
 */
export const terminalModes = { rawMode: false, bracketedPaste: false };

const PROMPT = "› ";
const CONTINUATION = "  ";
const ESC_FLUSH_MS = 40;

function defaultOnSignal(signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void): () => void {
  process.on(signal, handler);
  return () => process.off(signal, handler);
}

/** Kürzt eine einzeilige Angabe auf die Terminalbreite (ohne Umbruch) */
function fit(text: string, columns: number): string {
  const max = Math.max(10, columns - 1);
  if (displayWidth(text) <= max) return text;
  let out = "";
  for (const ch of stripStyle(text)) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export async function runChatApp(options: ChatAppOptions): Promise<number> {
  const { stdin, stdout, env } = options;
  const full = !!stdin.isTTY && !!stdout.isTTY && typeof stdin.setRawMode === "function" && wantsColor(env, true);
  const style: Style = createStyle(full);
  const onSignal = options.onSignal ?? defaultOnSignal;
  const gate = new InterruptGate(options.ctrlCWindowMs ?? 2000, options.now);
  const editor = new LineEditor();
  const decoder = new KeyDecoder();
  const cleanups: (() => void)[] = [];

  let finish: (code: number) => void = () => {};
  const done = new Promise<number>(resolve => {
    finish = resolve;
  });
  let exited = false;

  // --- Ausgabe -----------------------------------------------------------
  /** Zeile des Cursors innerhalb des unteren Bereichs (Status + Eingabe) */
  let regionCursorRow = 0;
  let regionShown = false;
  let status: string | null = null;
  let lastPlainStatus: string | null = null;

  // Breite 0 oder unbekannt (manche Pseudo-Terminals): wie ein übliches Terminal rechnen
  const columns = () => {
    const c = stdout.columns;
    return typeof c === "number" && c > 0 ? Math.max(20, c) : 80;
  };
  const write = (text: string) => {
    stdout.write(full ? text.replace(/\r?\n/g, "\r\n") : text);
  };

  function clearRegion(): void {
    if (!full || !regionShown) return;
    stdout.write(`\r${regionCursorRow > 0 ? `\u001b[${regionCursorRow}A` : ""}\u001b[J`);
    regionShown = false;
    regionCursorRow = 0;
  }

  /** Zeichnet Statuszeile und Eingabe; der Bereich beginnt links an der aktuellen Zeile */
  function drawRegion(): void {
    if (!full || exited) return;
    const cols = columns();
    const rows: string[] = [];
    if (status) rows.push(style.dim(fit(status, cols)));
    const input = editor.render(style.cyan(PROMPT), CONTINUATION);
    const statusRows = rows.length;
    let out = rows.map(r => `${r}\r\n`).join("");
    // Zeilen der Eingabe, umgebrochen durch die Terminalbreite
    let row = statusRows;
    let cursorRow = 0;
    let cursorCol = 0;
    input.lines.forEach((line, i) => {
      const width = displayWidth(line);
      if (i === input.cursorLine) {
        cursorRow = row + Math.floor(input.cursorColumn / cols);
        cursorCol = input.cursorColumn % cols;
      }
      out += line;
      const isLast = i === input.lines.length - 1;
      if (!isLast) {
        out += "\r\n";
        row += Math.max(1, Math.ceil(width / cols));
      } else {
        // Genau volle Zeile: ein Leerzeichen erzwingt den Umbruch, dann ist die Endposition eindeutig
        if (width > 0 && width % cols === 0) out += " ";
        row += Math.floor(width / cols);
      }
    });
    out += "\r";
    const up = row - cursorRow;
    if (up > 0) out += `\u001b[${up}A`;
    if (cursorCol > 0) out += `\u001b[${cursorCol}C`;
    stdout.write(out);
    regionShown = true;
    regionCursorRow = cursorRow;
  }

  /** Text über dem unteren Bereich ausgeben */
  function print(text: string): void {
    if (exited) return;
    clearRegion();
    write(`${text}\n`);
    drawRegion();
  }

  let conversation = options.conversation;

  function printMessage(m: Message): void {
    print(`${formatMessage(m, style, conversation.agent)}\n`);
  }

  function note(text: string, kind: "info" | "error" = "info"): void {
    print(kind === "error" ? style.red(text) : style.dim(text));
  }

  function setStatus(text: string | null): void {
    if (full) {
      if (text === status) return;
      clearRegion();
      status = text;
      drawRegion();
      return;
    }
    // Schlicht: jeden neuen Schritt als eigene Zeile, Laufzeit nicht (sonst jede Sekunde eine Zeile)
    const step = text?.replace(/ \(\d+ s\)$/, "") ?? null;
    if (step && step !== lastPlainStatus) write(`… ${step}\n`);
    lastPlainStatus = step;
  }

  /**
   * Sitzung für ein Gespräch. Ausgaben einer alten Sitzung (verspätete
   * Live-Ereignisse nach /wechsel) fallen weg: nur die aktuelle zeigt etwas.
   */
  function createSession(c: ConversationSummary): ChatSession {
    const own = (): boolean => session === created;
    const created: ChatSession = new ChatSession({
      client: options.client,
      conversation: c,
      output: {
        message: m => own() && printMessage(m),
        note: (text, kind) => own() && note(text, kind),
        status: text => own() && setStatus(text),
        choice: (c, reminder) => {
          if (!own()) return;
          const settled = choiceStatusText(c);
          if (settled) print(style.dim(settled));
          else if (c.options.length) print(`${style.dim(reminder ? "Zahlen gelten wieder für die frühere Rückfrage:" : "Rückfrage:")} ${choiceOptionsText(c, style)}`);
        },
      },
      live: options.live,
      now: options.now,
    });
    return created;
  }
  let session: ChatSession = createSession(conversation);

  /** Gespräch öffnen: Kopfzeile, Verlauf, Live-Verbindung */
  async function open(c: ConversationSummary, info?: string, first = false): Promise<void> {
    write(`${headerLine(c, style)}\n`);
    if (first && full) write(`${hintLine(style)}\n`);
    if (info) write(`${style.yellow(info)}\n`);
    write("\n");
    try {
      await session.loadHistory();
    } catch (e) {
      write(`${style.red(`Verlauf nicht lesbar: ${e instanceof Error ? stripStyle(e.message) : String(e)}`)}\n`);
    }
    session.startLive();
  }

  /** /wechsel und /neu: alte Live-Verbindung schließen, neues Gespräch öffnen, Auswahl merken */
  async function switchTo(c: ConversationSummary, info?: string): Promise<void> {
    const old = session;
    conversation = c;
    session = createSession(c);
    void old.close();
    clearRegion();
    status = null;
    lastPlainStatus = null;
    write("\n");
    await open(c, info);
    drawRegion();
    try {
      await options.onSwitch?.(c);
    } catch {
      // Merken ist nur Komfort
    }
  }

  // --- Beenden -----------------------------------------------------------
  function restoreTerminal(): void {
    if (!full) return;
    clearRegion();
    if (terminalModes.bracketedPaste) stdout.write("\u001b[?2004l");
    terminalModes.bracketedPaste = false;
    if (terminalModes.rawMode) {
      try {
        stdin.setRawMode?.(false);
      } catch {
        // Terminal schon weg
      }
    }
    terminalModes.rawMode = false;
  }

  function exit(code: number): void {
    if (exited) return;
    restoreTerminal();
    exited = true;
    for (const c of cleanups.splice(0)) c();
    stdin.pause?.();
    finish(code);
  }

  // --- Eingabe -----------------------------------------------------------
  let sending = false;
  /** Schlicht: Zeilen, die warten, bis die laufende Antwort fertig ist */
  const queue: string[] = [];
  let inputEnded = false;

  /** Ein Befehl läuft (Liste laden, Topic anlegen …); Nachrichten warten so lange */
  let commandRunning = false;

  const runner = new CommandRunner({
    client: options.client,
    style,
    current: () => conversation,
    switchTo,
    updateCurrent: c => {
      conversation = c;
    },
    info: text => print(style.dim(text)),
    error: text => note(text, "error"),
    quit: () => exit(0),
    now: options.now,
  });

  /** Befehl oder Hinweis zu einer Eingabe mit /; false, wenn nichts geklappt hat */
  async function runCommand(parsed: Exclude<ParsedInput, { kind: "message" }>): Promise<boolean> {
    if (parsed.kind !== "command") {
      note(parsed.error, "error");
      return false;
    }
    const { command } = parsed;
    // Beenden und Tastenhilfe gehen immer sofort, auch während eine Antwort oder ein Befehl läuft
    if (command.type === "quit" || command.type === "keys") return runner.run(command);
    if (commandRunning) {
      note("Einen Moment, der vorige Befehl läuft noch.", "error");
      return false;
    }
    commandRunning = true;
    try {
      return await runner.run(command);
    } finally {
      commandRunning = false;
    }
  }

  /**
   * Zahl oder /<zahl>, solange im Gespräch eine Rückfrage offen ist (Issue
   * #120); null: normale Eingabe (Nachricht oder Befehl wie bisher)
   */
  function choiceNumber(text: string): number | null {
    const n = parseChoiceNumber(text);
    return n !== null && session.choiceTarget ? n : null;
  }

  /** Auswahl-Anfragen, die noch auf den Server warten; Eingabeende beendet erst danach */
  let choosing = 0;

  /** Auswahl senden; true, wenn der Entwurf nicht zurückkommen soll */
  async function choose(n: number): Promise<boolean> {
    choosing++;
    try {
      const outcome = await session.choose(n);
      // Zwischen Prüfung und Aufruf liegt kein await, also kommt das nicht vor; dann nichts senden
      if (!outcome.handled) {
        note("Keine offene Rückfrage mehr, nichts gesendet.", "error");
        return false;
      }
      if (outcome.error) note(outcome.error, "error");
      return outcome.ok || outcome.settled;
    } finally {
      choosing--;
      // Schlicht: ist die Eingabe inzwischen zu Ende, erst jetzt beenden
      if (!full) void pump();
    }
  }

  async function submit(text: string): Promise<boolean> {
    const n = choiceNumber(text);
    if (n !== null) return choose(n);
    const parsed = parseInput(text);
    if (parsed.kind !== "message") return runCommand(parsed);
    sending = true;
    const outcome = await session.send(parsed.text);
    sending = false;
    if (!outcome.ok) note(outcome.error, "error");
    return outcome.ok;
  }

  /** Tab: Befehl, Gesprächs- oder Agentennamen ergänzen; mehrere Treffer werden gezeigt */
  function complete(): void {
    const names = runner.conversationNames;
    if (names.length === 0 || runner.agentNames.length === 0) void runner.preload();
    const result = completeInput(editor.text, { conversations: names, agents: runner.agentNames, commands: runner.commandNames });
    if (!result) return;
    if (result.text !== editor.text) editor.setText(result.text);
    if (result.options.length > 1) {
      const shown = result.options.slice(0, 20).map(o => sanitizeLine(o));
      print(style.dim(`${shown.join("   ")}${result.options.length > 20 ? `   … (${result.options.length - 20} weitere)` : ""}`));
    }
  }

  /** Nachricht (kein lokaler Befehl), die gerade nicht gesendet werden kann; /stop und /goal pause|stop gehen immer */
  function blockedMessage(text: string): string | null {
    // Auswahl einer Rückfrage geht immer, auch während einer Antwort
    if (choiceNumber(text) !== null) return null;
    const parsed = parseInput(text);
    if (parsed.kind !== "message" || parsed.urgent) return null;
    if (commandRunning) return "Einen Moment, der Befehl läuft noch. Der Text bleibt stehen.";
    if (sending || (session.isRunning && !session.isAwaiting)) return "Es läuft noch eine Antwort. Warten oder mit Strg+C stoppen, der Text bleibt stehen.";
    return null;
  }

  function interrupt(): void {
    const action = gate.press(session.isRunning);
    if (action === "exit") {
      exit(0);
      return;
    }
    if (action === "stop") {
      note(`Stoppe die Antwort … (noch einmal Strg+C beendet ${BRAND.name})`);
      void session.stop();
      return;
    }
    note(`Noch einmal Strg+C (oder Strg+D) beendet ${BRAND.name}.`);
  }

  function onKeys(data: string): void {
    for (const key of decoder.push(data)) {
      const action = editor.handle(key);
      if (action.type === "interrupt") {
        interrupt();
        if (exited) return;
        continue;
      }
      if (action.type === "eof") {
        exit(0);
        return;
      }
      if (action.type === "complete") {
        complete();
        continue;
      }
      if (action.type === "submit") {
        // Befehle vor der Sperre: /stop muss gerade während einer Antwort gehen
        const blocked = blockedMessage(action.text);
        if (blocked) {
          // Entwurf behalten: die Antwort läuft noch
          editor.setText(action.text);
          note(blocked);
          continue;
        }
        clearRegion();
        drawRegion();
        void submit(action.text).then(ok => {
          if (!ok && !exited && !editor.text) {
            clearRegion();
            editor.setText(action.text);
            drawRegion();
          }
        });
        continue;
      }
    }
    clearRegion();
    drawRegion();
  }

  /**
   * Schlicht: nächste wartende Zeile senden, sobald nichts läuft; nach Ende
   * der Eingabe beenden, aber erst nach dem Abgleich einer Wiederverbindung
   * (sonst fehlt eine Antwort, die in der Unterbrechung kam). Ist der
   * Abgleich endgültig gescheitert, endet tybo mit Fehler.
   */
  let pumping = false;
  async function pump(): Promise<void> {
    // Nur ein Durchgang zur Zeit: sonst beendet ein zweiter tybo, während der erste noch einen Befehl ausführt
    if (pumping) return;
    pumping = true;
    try {
      while (!exited && !sending && !commandRunning && (!session.isRunning || session.isAwaiting) && queue.length > 0) {
        const text = queue.shift()!;
        const ok = await submit(text);
        if (!ok && !stdin.isTTY) {
          exit(1);
          return;
        }
      }
      if (!exited && inputEnded && queue.length === 0 && !sending && !commandRunning && choosing === 0 && !session.isRunning && !session.isSyncing) {
        exit(session.syncFailed ? 1 : 0);
      }
    } finally {
      pumping = false;
    }
  }

  let partial = "";
  let continued: string[] = [];
  function onLines(data: string): void {
    partial += data;
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() ?? "";
    for (const line of parts) takeLine(line);
    void pump();
  }
  function takeLine(line: string): void {
    if (line.endsWith("\\")) {
      continued.push(line.slice(0, -1));
      return;
    }
    const text = [...continued, line].join("\n");
    continued = [];
    if (!text.trim()) return;
    // Im Terminal: Auswahl einer offenen Rückfrage sofort, auch während einer Antwort.
    // Aus einer Pipe wartet sie wie jede Zeile, sonst träfe sie eine ältere Frage statt der kommenden
    if (stdin.isTTY && choiceNumber(text) !== null) {
      void submit(text);
      return;
    }
    const parsed = parseInput(text);
    // Im Terminal (nicht aus einer Pipe) gehen Beenden und Tastenhilfe sofort, nicht erst nach der Antwort
    if (stdin.isTTY && parsed.kind === "command" && ["quit", "keys"].includes(parsed.command.type)) {
      void runCommand(parsed);
      return;
    }
    // /stop und /goal pause|stop ebenso: der Server führt sie auch während einer Antwort aus (Issue #74, #76)
    if (stdin.isTTY && parsed.kind === "message" && parsed.urgent) {
      void submit(text);
      return;
    }
    if (parsed.kind === "message" && (sending || commandRunning || (session.isRunning && !session.isAwaiting))) {
      if (stdin.isTTY) note("Wird gesendet, sobald die laufende Antwort fertig ist.");
    }
    queue.push(text);
  }

  // --- Start ---------------------------------------------------------------
  await open(conversation, options.note, true);
  cleanups.push(() => void session.close());
  // Namen für die Tab-Ergänzung
  void runner.preload();

  const off: (() => void)[] = [];
  off.push(onSignal("SIGTERM", () => exit(143)));
  off.push(onSignal("SIGHUP", () => exit(129)));
  cleanups.push(() => off.forEach(f => f()));

  // Zustandsbehaftet: ein Umlaut oder Emoji kann über zwei Blöcke verteilt ankommen
  const utf8 = new TextDecoder();
  const decode = (chunk: Buffer | string) => (typeof chunk === "string" ? chunk : utf8.decode(chunk, { stream: true }));

  if (full) {
    stdin.setRawMode!(true);
    terminalModes.rawMode = true;
    stdout.write("\u001b[?2004h");
    terminalModes.bracketedPaste = true;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const onData = (chunk: Buffer | string) => {
      clearTimeout(flushTimer);
      onKeys(decode(chunk));
      flushTimer = setTimeout(() => decoder.flush(), ESC_FLUSH_MS);
    };
    stdin.on("data", onData);
    stdin.on("end", () => {
      const rest = utf8.decode();
      if (rest && !exited) onKeys(rest);
      exit(0);
    });
    cleanups.push(() => {
      clearTimeout(flushTimer);
      stdin.off?.("data", onData);
    });
    const tick = setInterval(() => session.tick(), options.tickMs ?? 1000);
    cleanups.push(() => clearInterval(tick));
    const onResize = () => {
      clearRegion();
      drawRegion();
    };
    stdout.on?.("resize", onResize);
    cleanups.push(() => stdout.off?.("resize", onResize));
    drawRegion();
  } else {
    // Strg+C kommt hier als Signal (Terminal im Zeilenmodus)
    off.push(onSignal("SIGINT", interrupt));
    const onData = (chunk: Buffer | string) => onLines(decode(chunk));
    stdin.on("data", onData);
    stdin.on("end", () => {
      partial += utf8.decode();
      if (partial) takeLine(partial);
      partial = "";
      inputEnded = true;
      void pump();
    });
    cleanups.push(() => stdin.off?.("data", onData));
    // Nach jeder Antwort die nächste wartende Zeile
    const poll = setInterval(() => void pump(), 50);
    cleanups.push(() => clearInterval(poll));
  }
  stdin.resume?.();

  const code = await done;
  await session.close();
  return code;
}
