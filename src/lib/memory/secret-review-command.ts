/**
 * tybo gedaechtnis geheimnisse (Issue #524). Eigener Prozess neben dem Bot wie
 * bereinigen: Die Fragen kommen ins Register (data/choices.json) und in den
 * Direktchat, mit Telegram dorthin und über die Outbox in die WebUI, ohne Telegram
 * nur in den Web-Direktchat. Den Klick beantwortet der laufende Bot
 * (secret-review.ts). Die Ausgabe zeigt Kennung und maskierten Text, nie den Wert.
 */
import { Api } from "grammy";
import { BRAND } from "../../brand";
import { dmChatId, telegramConfigured } from "../channels";
import { useChoicesFileIn } from "../choices";
import { getStore } from "../store";
import { createTelegramChoices, type ChoiceEditApi, type TelegramChoicesDeps } from "../telegram-choices";
import { offerSecretFacts, secretDecisionsFile } from "./secret-review";

type Env = Record<string, string | undefined>;

export const SECRET_COMMAND = "geheimnisse";

export interface SecretCommandOptions {
  root: string;
  env: Env;
  out(line: string): void;
  err(line: string): void;
  /** Nur für Tests: Bot-API und Versand ersetzen */
  createApi?(token: string): ChoiceEditApi;
  send?: TelegramChoicesDeps["send"];
}

export function secretCommandUsage(): string {
  return [
    `${BRAND.cli} gedaechtnis geheimnisse [--alle]        Fakten mit Passwort oder Schlüssel mit Kennung und maskiertem Wert zeigen, per Knopf behalten oder archivieren; --alle auch schon behaltene`,
    "",
    "Die Fragen kommen nur in den Direktchat, entschieden wird dort, solange der Bot läuft. Behaltene Fakten stehen in Prompts und Ausgaben weiter maskiert.",
  ].join("\n");
}

export async function runSecretCommand(args: string[], o: SecretCommandOptions): Promise<number> {
  const [, ...rest] = args;
  const all = rest.length === 1 && rest[0] === "--alle";
  if (rest.length > 0 && !all) {
    o.err(`Aufruf: ${BRAND.cli} gedaechtnis geheimnisse [--alle]`);
    return 2;
  }
  const memory = () => getStore().memory;
  try {
    // Prüft nebenbei, ob die Migration eingespielt ist; sonst scheiterte später jedes Archivieren
    await memory().archivedFacts();
  } catch (e) {
    o.err(`Das Archiv ist nicht erreichbar, nichts vorgelegt. Ist die Migration 20261031_memory_archive.sql eingespielt? (${e instanceof Error ? e.name : "Fehler"})`);
    return 1;
  }

  useChoicesFileIn(o.root);
  const telegram = telegramConfigured(o.env);
  const createApi = o.createApi ?? ((token: string) => new Api(token));
  const choices = createTelegramChoices({
    ...(telegram ? { api: createApi(o.env.TELEGRAM_BOT_TOKEN!.trim()), owner: o.env.TELEGRAM_USER_ID!.trim() } : {}),
    ...(o.send ? { send: o.send } : {}),
    telegram: () => telegramConfigured(o.env),
  });

  try {
    const report = await offerSecretFacts(
      { type: "telegram", chatId: dmChatId(o.env) },
      { file: secretDecisionsFile(o.root), memory, sendChoice: choice => choices.sendChoice(choice) },
      { all },
    );
    if (report.found === 0) {
      o.out("Kein gespeicherter Fakt sieht nach einem Geheimnis aus.");
      return 0;
    }
    for (const fact of report.open) o.out(`${fact.id}  ${fact.masked}`);
    o.out(
      `Fakten mit Geheimnis: ${report.found} · schon behalten: ${report.kept} · Frage schon offen: ${report.waiting} · ` +
        `neu vorgelegt: ${report.offered} · für den nächsten Aufruf: ${report.later}`,
    );
    if (report.notDelivered > 0) {
      o.err(`${report.notDelivered} Fragen kamen nicht an, nichts geändert. Derselbe Befehl kann gefahrlos wiederholt werden.`);
      return 1;
    }
    if (report.offered + report.waiting > 0) o.out("Die Fragen stehen im Direktchat, entschieden wird dort, solange der Bot läuft, je Frage höchstens 7 Tage lang.");
    return 0;
  } catch (e) {
    o.err(`Fakten oder Vermerk nicht lesbar, nichts vorgelegt (${e instanceof Error ? e.name : "Fehler"}).`);
    return 1;
  }
}
