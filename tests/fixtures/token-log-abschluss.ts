/**
 * Issue #526: echte Bun-Ausgabe beim Stream-Abschluss. Nur erfundene Tokens
 * aus der Testumgebung, kein Bot-Import. Die Gegenstelle meldet den Callback.
 */
import { flushLogMask, installLogMask } from "../../src/lib/telegram-token-mask";

installLogMask();

const [channel, kind, mode] = process.argv.slice(2);
const stream = channel === "stdout" ? process.stdout : process.stderr;
const other = channel === "stdout" ? process.stderr : process.stdout;
const main = process.env.TELEGRAM_BOT_TOKEN!;
const agent = process.env.TELEGRAM_BOT_TOKEN_RESEARCH!;
const prefix = "Grüße ✓ https://api.telegram.org/bot";
const payload = `${prefix}${main}/sendMessage file/bot${encodeURIComponent(agent)}/photos/a.jpg`;

function write(text: string): void {
  if (kind === "hex") stream.write(Buffer.from(text).toString("hex"), "hex");
  else stream.write(chunk(text));
}

function chunk(text: string): string | Uint8Array {
  if (kind === "bytes") return Buffer.from(text);
  if (kind === "uint8") return new TextEncoder().encode(text);
  return text;
}

let tail: string | undefined = payload;
if (mode === "haupt") {
  const at = prefix.length + main.indexOf(":") + 7;
  write(payload.slice(0, at));
  tail = payload.slice(at);
} else if (mode === "kodiert") {
  // Die Escape-Sequenz selbst liegt über der Grenze zwischen write und end.
  const at = payload.indexOf("%3A") + 1;
  write(payload.slice(0, at));
  tail = payload.slice(at);
} else if (mode === "ohne-chunk") {
  write(payload);
  tail = undefined;
} else if (mode === "lang") {
  write(main + "x".repeat(20_000) + agent + "y".repeat(1000));
  tail = "\n";
}

const done = (error?: Error | null) => {
  if (error) throw error;
  // Ein zweites Leeren darf weder schreiben noch etwas doppelt ausgeben.
  flushLogMask();
  other.write("Abschluss genau einmal\n");
};
const returned = tail === undefined ? stream.end(done)
  : kind === "hex" ? stream.end(Buffer.from(tail).toString("hex"), "hex", done)
  : stream.end(chunk(tail), done);
if (returned !== stream) throw new Error("end liefert nicht den eigenen Stream");
