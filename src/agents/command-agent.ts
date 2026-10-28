/**
 * Agentenname im Befehl /agent (Issue #304, vorher in src/bot.ts).
 *
 * Gross- und Kleinschreibung zaehlt nicht, Leerzeichen bleiben stehen. Ein
 * Alias aus COMMAND_ALIASES wird zur Kennung; gilt nur, wenn der Agent jetzt
 * aktiv ist. Der Aufrufer reicht die Pruefung herein und fragt so bei jedem
 * Befehl den aktuellen Katalog (eigene Agenten, geloeschte).
 */
import { COMMAND_ALIASES } from "./names";

export function resolveCommandAgentName(input: string, isActive: (name: string) => boolean): string | undefined {
  const key = input.toLowerCase();
  const id = Object.hasOwn(COMMAND_ALIASES, key) ? COMMAND_ALIASES[key] : key;
  if (!isActive(id)) return undefined;
  return id;
}
