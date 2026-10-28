/**
 * Rückfragen-Register für die WebUI (Issue #115): der ChoicePort aus
 * ./choices mit dem echten Register (src/lib/choices.ts, data/choices.json).
 * Gelesen wird mit getChoiceChecked und listChoices, die bei einer nicht
 * lesbaren Ablage werfen: der Port hält dann den letzten verlässlichen Stand.
 * Nur src/bot.ts bindet diese Datei ein.
 */

import { decideChoice, getChoiceChecked, listChoices, onChoiceChange } from "../lib/choices";
import { createChoicePort, type ChoicePort } from "./choices";
import { dmChatId } from "../lib/channels";
import { botGroupId } from "./bot-telegram";

type Env = Record<string, string | undefined>;

export function createBotChoices(env: Env, log?: (message: string) => void): ChoicePort {
  return createChoicePort({
    register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
    userId: dmChatId(env),
    groupId: () => botGroupId(env),
    log,
  });
}
