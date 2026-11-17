/**
 * Issue #526: eigener Prozess für den Ausgabetest. Schaltet die Maskierung
 * ein wie der Bot und gibt dann einen nachgestellten Netzfehler von grammY
 * aus (erfundene Tokens aus der Umgebung des Tests): über jede console-
 * Methode, direkt auf stderr/stdout als Zeichenkette und als Bytes, und
 * über mehrere write-Aufrufe verteilt. Der Test liest die tatsächliche
 * Ausgabe.
 */
import { HttpError } from "grammy";
import { installLogMask } from "../../src/lib/telegram-token-mask";

installLogMask();

const main = process.env.TELEGRAM_BOT_TOKEN!;
const agent = process.env.TELEGRAM_BOT_TOKEN_RESEARCH!;

const inner = Object.assign(new Error(`Unable to connect. Is the computer able to access the url? bot${agent}/getMe`), {
  code: "ConnectionRefused",
  path: `https://api.telegram.org/bot${main}/sendMessage`,
  errno: 0,
});
inner.cause = new Error(`fetch failed: https://api.telegram.org/file/bot${encodeURIComponent(agent)}/photos/a.jpg`);
inner.stack = `Error: Unable to connect\n    at fetch (https://api.telegram.org/bot${main}/getUpdates)`;
const error = new HttpError("Network request for 'sendMessage' failed!", inner);
const url = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

// console: jede Methode, die etwas ausgibt
console.error("[Telegram] Antwort fehlgeschlagen:", error);
console.log("Text handler error:", { nested: { deeper: [error] } });
console.warn(`Warnung: bot${agent}/getMe`);
console.info(`info: ${url(main, "getChat")}`);
console.debug(`debug: ${url(agent, "getChat")}`);
console.dir(error, { depth: 5 });
console.dir({ dir: url(agent, "dirMethod") });
console.dirxml(`dirxml: ${url(main, "dirxmlMethod")}`);
console.table([{ spalte: url(main, "tableMethod"), agent: url(agent, "tableAgent") }]);
console.assert(false, `assert: ${url(main, "assertMethod")}`);
console.count(`count: ${url(agent, "countMethod")}`);
console.countReset(`count: ${url(agent, "countMethod")}`);
console.group(`group: ${url(main, "groupMethod")}`);
console.log(`in der Gruppe: ${url(agent, "inGroup")}`);
console.groupEnd();
console.time(`zeit: ${url(main, "timeMethod")}`);
console.timeLog(`zeit: ${url(main, "timeMethod")}`, error);
console.timeEnd(`zeit: ${url(main, "timeMethod")}`);
console.trace(`trace: ${url(agent, "traceMethod")}`);
(console as unknown as { write(...data: unknown[]): number }).write(`console.write: ${url(main, "consoleWrite")}\n`);

// direkt als Zeichenkette und als Bytes
process.stderr.write(`direkt: ${url(main, "sendMessage")}\n`);
process.stdout.write(`direkt: ${url(agent, "sendMessage")}\n`);
process.stderr.write(Buffer.from(`buffer: ${url(main, "bufferMethod")}\n`));
process.stdout.write(new TextEncoder().encode(`uint8: ${url(agent, "uint8Method")}\n`));
process.stdout.write(Buffer.from(`hex: ${url(main, "hexMethod")}\n`).toString("hex"), "hex");

// über mehrere Aufrufe verteilt: mitten im Token, an Doppelpunkt und %3A
const split = (stream: NodeJS.WriteStream, text: string, at: number[]) => {
  let from = 0;
  for (const to of [...at, text.length]) {
    stream.write(text.slice(from, to));
    from = to;
  }
};
const geteilt = `geteilt: ${url(main, "splitMain")}\n`;
split(process.stderr, geteilt, [geteilt.indexOf(":AAFake") + 6, geteilt.indexOf("Haupt") + 3]);
const geteiltAgent = `geteilt: ${url(agent, "splitAgent")}\n`;
split(process.stdout, geteiltAgent, [geteiltAgent.indexOf("777") + 2, geteiltAgent.indexOf("777") + 4]);
const kodiert = `kodiert: file/bot${encodeURIComponent(agent)}/b.jpg\n`;
split(process.stderr, kodiert, [kodiert.indexOf("%3A") + 1]);
// Bytes einzeln, auch ein UTF-8-Zeichen in zwei Hälften
for (const byte of Buffer.from(`Grüße ✓ ${url(main, "byteweise")}\n`)) process.stdout.write(Buffer.from([byte]));
// Das Original bleibt unverändert (Fehlerklassifikation sieht weiter das echte Objekt)
console.log(`original-unveraendert: ${(error.error as { path: string }).path.includes(main)}`);
// Zum Schluss ohne Zeilenende: kommt beim Beenden heraus, maskiert
process.stdout.write(`ende: bot${main}`);
