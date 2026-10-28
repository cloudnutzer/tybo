/**
 * Echte Quelle der Routinen-API (Issue #284) für src/bot.ts: listRoutines
 * aus src/lib/routines/catalog.ts mit den echten Befehlen (lesend:
 * plutil, launchctl list, launchctl print-disabled und die Prozessliste
 * vom laufenden PM2-Daemon). Wie
 * bot-status.ts bindet nur src/bot.ts diese Datei ein; web:dev und Demo
 * nutzen createDemoRoutines aus ./demo.
 *
 * Knöpfe (Issue #288): actions je Routine aus menuActions, Aktionen über
 * dieselbe Entscheidung wie Telegram (RoutineChoices.fromSettings aus
 * src/lib/routine-choices.ts): offene Rückfragen derselben Aktion werden im
 * Register entschieden, alles läuft je Routine nacheinander.
 */

import { PROJECT_ROOT } from "../lib/env";
import type { RoutineChoices } from "../lib/routine-choices";
import { menuActions } from "../lib/routines/actions";
import { defaultRoutinesDeps, listRoutines, routineHistory } from "../lib/routines/catalog";
import type { Routine } from "../lib/routines/types";
import type { RoutinesPort } from "./routines";

export function createBotRoutines(env: Record<string, string | undefined>, choices?: Pick<RoutineChoices, "fromSettings">): RoutinesPort {
  const deps = defaultRoutinesDeps(PROJECT_ROOT, env);
  const withActions = (r: Routine) => ({ ...r, actions: menuActions(r) });
  return {
    home: deps.home,
    list: async () => {
      const list = await listRoutines(deps);
      return { ...list, routines: list.routines.map(withActions) };
    },
    // Verlauf (Issue #285) nur nach Label, nicht nach Name: die Adresse nennt die id
    runs: async id => {
      const history = await routineHistory(deps, id, "id");
      return history ? { ...history, routine: withActions(history.routine) } : null;
    },
    ...(choices
      ? {
          act: async (id, action, confirm, request) => {
            const outcome = await choices.fromSettings(id, action, confirm, request);
            if (outcome.status === "confirm-required") return outcome;
            const r = outcome.result;
            return { status: r.status, text: r.text, routine: r.routine ? withActions(r.routine) : null };
          },
        }
      : {}),
  };
}
