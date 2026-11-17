/**
 * Issue #526: eigener Prozess für den Test unbehandelter Promise-Ablehnungen.
 * Bun gibt sie sonst nativ aus, an der Maskierung vorbei. Schaltet die
 * Maskierung ein wie der Bot, im Modus "lebenszyklus" auch die Signal-Handler
 * aus src/app/lifecycle.ts (wie bot.ts), im Modus "nur-maske" nicht. Dann
 * wird ein nachgestellter Netzfehler mit erfundenen Tokens aus der Umgebung
 * abgelehnt, ohne dass jemand die Ablehnung behandelt. Das zweite Argument
 * wählt den Weg: "void" (Standard) lehnt ein Promise ab, "throw" wirft auf
 * oberster Ebene, "await" wartet dort auf die Ablehnung. Die beiden letzten
 * meldet Bun als uncaughtException, wie einen Startfehler im Bot vor
 * installSignalHandlers.
 */
import { HttpError } from "grammy";
import { createLifecycle, installSignalHandlers } from "../../src/app/lifecycle";
import { installLogMask } from "../../src/lib/telegram-token-mask";

installLogMask();

if (process.argv[2] === "lebenszyklus") {
  const lifecycle = createLifecycle({
    lock: { touch: async () => {}, release: async () => console.log("Sperre frei") },
    exit: code => process.exit(code),
    settleMs: 10,
  });
  lifecycle.onShutdown("Probe", () => console.log("closer gelaufen"));
  installSignalHandlers(lifecycle, {
    on: (event, handler) => void process.on(event, handler),
    report: async error => console.log(`gemeldet: ${error.message}`),
  });
}

const main = process.env.TELEGRAM_BOT_TOKEN!;
const agent = process.env.TELEGRAM_BOT_TOKEN_RESEARCH!;

const inner = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
  code: "ConnectionRefused",
  path: `https://api.telegram.org/bot${main}/sendMessage`,
  request: { url: `https://api.telegram.org/file/bot${encodeURIComponent(main)}/photos/a.jpg` },
});
inner.cause = Object.assign(new Error(`fetch failed bot${agent}/getMe`), {
  url: `https://api.telegram.org/bot${agent}/getUpdates`,
});
const error = new HttpError(`Network request for 'sendMessage' failed! bot${main}/sendMessage`, inner);

// Läuft der Prozess nach der Ablehnung weiter, erscheint diese Zeile
setTimeout(() => console.log("nicht abgebrochen"), 2000);
const variant = process.argv[3] ?? "void";
if (variant === "throw") throw error;
if (variant === "await") await Promise.reject(error);
void Promise.reject(error);
