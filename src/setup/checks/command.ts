/**
 * `tybo pruefen` (Issue #371) und der Alias `bun run setup:verify`: Bericht
 * ausgeben, Exit-Code zurückgeben. Richtet nichts ein und startet nichts.
 */

import { BRAND } from "../../brand";
import type { SetupContext } from "../context";
import { checkStep, SETUP_STEPS } from "../steps";
import { collectReport, formatReport, reportExitCode, type SpecialCheck } from "./report";
import { defaultSpecials } from "./specials";

export interface CheckCommandOptions {
  ctx: SetupContext;
  out(line: string): void;
  err(line: string): void;
  /** Standard: defaultSpecials() */
  specials?: readonly SpecialCheck[];
  timeoutMs?: number;
}

export function checkUsage(): string {
  return [
    `${BRAND.cli} pruefen   Prüfbericht: alle Einrichtungsschritte, Kanäle, Motor, Telegram, Datenbank, Dienste, Sprache`,
    "",
    "Schickt keine Testnachricht, schreibt nichts in die Datenbank und ruft kein Modell auf.",
    "Exit-Code 1, wenn etwas fehlgeschlagen ist, sonst 0 (auch mit Warnungen).",
    `Gleichbedeutend: bun run setup:verify`,
  ].join("\n");
}

export async function runCheckCommand(args: string[], options: CheckCommandOptions): Promise<number> {
  const [sub] = args;
  if (sub === "help" || sub === "--help" || sub === "-h") {
    options.out(checkUsage());
    return 0;
  }
  if (args.length) {
    options.err(`Unbekannter Aufruf: ${BRAND.cli} pruefen ${args.join(" ")}`);
    options.err(checkUsage());
    return 2;
  }
  const report = await collectReport({
    ctx: options.ctx,
    steps: SETUP_STEPS.filter(s => s !== checkStep),
    specials: options.specials ?? defaultSpecials(),
    timeoutMs: options.timeoutMs,
  });
  for (const line of formatReport(report)) options.out(line);
  return reportExitCode(report);
}
