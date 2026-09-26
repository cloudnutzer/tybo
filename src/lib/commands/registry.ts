/**
 * Befehls-Register (Issue #74): erkennt Befehle am Anfang einer Nachricht
 * und liefert die Liste je Kanal.
 *
 * Regeln für die Erkennung, gleich in allen Kanälen:
 * - Groß- und Kleinschreibung egal, Leerraum am Rand zählt nicht.
 * - Der Name endet an Leerraum oder am Ende: „/newspaper" ist nicht /new.
 *   In Telegram zählen wie bisher nur bestimmte Trennzeichen (Standard das
 *   Leerzeichen, bei /critic und /voice auch der Zeilenumbruch), damit dort
 *   nichts erkannt wird, was die frühere if-Kette nicht erkannt hat.
 * - Befehle ohne Argumente gelten nur allein („/new foo" geht als Text an
 *   Claude), Befehle mit Pflicht-Argument nur mit („/critic" allein auch).
 * - Wörter ohne Schrägstrich (bareWords, z. B. „goals") nur in Telegram,
 *   wie bisher; im Browser und im Terminal gehen sie als Text an Claude.
 * - Nicht registriert („/foo", „/k3 …"): kein Befehl, die Nachricht geht
 *   als Text an Claude.
 *
 * Keine Laufzeit-Importe außer den Typen.
 */

import type { CommandChannel, CommandDefinition, CommandInfo, CommandMatch } from "./types";

export interface CommandRegistry {
  match(text: string, channel: CommandChannel): CommandMatch | null;
  list(channel: CommandChannel): CommandInfo[];
  get(name: string): CommandDefinition | undefined;
}

export function createCommandRegistry(definitions: readonly CommandDefinition[]): CommandRegistry {
  // Namen mit Schrägstrich und Wörter ohne sind getrennte Räume („/goals" und „goals")
  const names = new Set<string>();
  for (const d of definitions) {
    for (const n of [...[d.name, ...d.aliases].map(a => `/${a}`), ...(d.bareWords ?? [])]) {
      if (names.has(n)) throw new Error(`Befehlsname doppelt: ${n}`);
      names.add(n);
    }
  }

  function match(text: string, channel: CommandChannel): CommandMatch | null {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    for (const command of definitions) {
      if (!command.channels.includes(channel)) continue;
      if (channel === "telegram" && command.bareWords?.includes(lower)) {
        return { command, invoked: lower, args: "" };
      }
      if (!lower.startsWith("/")) continue;
      for (const invoked of [command.name, ...command.aliases]) {
        const head = `/${invoked}`;
        if (!lower.startsWith(head)) continue;
        const rest = trimmed.slice(head.length);
        // Name endet an Leerraum oder am Ende (/newspaper ist nicht /new);
        // Telegram nur an den bisherigen Trennzeichen (telegramArgSeparators)
        if (rest && !(channel === "telegram" ? (command.telegramArgSeparators ?? [" "]).includes(rest[0]) : /^\s/.test(rest))) continue;
        const args = rest.trim();
        if (command.args === "none" && args) continue;
        if (command.args === "required" && !args) continue;
        return { command, invoked, args };
      }
    }
    return null;
  }

  function list(channel: CommandChannel): CommandInfo[] {
    return definitions
      .filter(d => d.channels.includes(channel))
      .map(d => ({
        name: d.name,
        aliases: [...d.aliases],
        description: d.description,
        args: d.args,
        ...(d.argsHint ? { argsHint: d.argsHint } : {}),
      }));
  }

  return { match, list, get: name => definitions.find(d => d.name === name) };
}
