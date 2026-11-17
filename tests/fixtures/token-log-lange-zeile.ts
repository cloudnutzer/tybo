/**
 * Issue #526: eigener Prozess für lange Zeilen ohne Trennzeichen. Schaltet die
 * Maskierung ein wie der Bot und schreibt auf stdout und stderr je zweimal
 * Token, 20000 x, zweites Token, 1000 y in einem Aufruf und danach das
 * Zeilenende in einem zweiten, einmal Haupt- vor Agenten-Token, einmal
 * umgekehrt (erfundene Tokens aus der Umgebung des Tests). Die Teilung im
 * langen Lauf fällt in das zweite Token.
 */
import { installLogMask } from "../../src/lib/telegram-token-mask";

installLogMask();

const main = process.env.TELEGRAM_BOT_TOKEN!;
const agent = process.env.TELEGRAM_BOT_TOKEN_RESEARCH!;

for (const stream of [process.stdout, process.stderr]) {
  for (const [first, second] of [
    [main, agent],
    [agent, main],
  ]) {
    stream.write(first + "x".repeat(20_000) + second + "y".repeat(1000));
    stream.write("\n");
  }
}
