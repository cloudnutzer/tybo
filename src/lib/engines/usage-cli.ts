/** Kurzer Prozess für externe Messungen, ohne Bot, Netz oder eigenen Meldeweg. */
import { readUsage, recordUsage } from "./usage";
import { parseExternalUsageArgs } from "./usage-input";
import { applyMeasurement, formatSwitchTime, type SwitchAuto, type SwitchBlock } from "../engine-switch";
import { readSwitchState, updateSwitchState, type SwitchStateResult } from "../engine-switch-state";
import { engineAuto } from "../settings";

export interface UsageCliOptions {
  now?: () => number;
  stdin?: () => Promise<string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  auto?: () => SwitchAuto;
  wait?: (ms: number) => Promise<unknown>;
  timeZone?: string;
  updateState?: typeof updateSwitchState;
}

/** Nur Änderungen an einem eingelieferten Fenster beschreiben. */
function blockChange(before: readonly SwitchBlock[], after: readonly SwitchBlock[], timeZone: string): string | undefined {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  const latest = after.reduce<SwitchBlock | undefined>((previous, block) =>
    !previous || Date.parse(block.until) > Date.parse(previous.until) ? block : previous, undefined);
  if (!latest) return before.length ? "Sperre aufgehoben" : undefined;
  const time = formatSwitchTime(latest.until, timeZone);
  const unknownReset = latest.cause === "threshold"
    ? " (60 Minuten ab der Messung, Reset-Zeit unbekannt)" : " (Reset-Zeit unbekannt)";
  return `Sperre bis ${time}${latest.resetKnown ? "" : unknownReset}`;
}

export async function runUsageCli(args: readonly string[], options: UsageCliOptions = {}): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  try {
    switch (args[0]) {
      case "show": {
        if (args.length !== 1) throw new Error("show: keine weiteren Argumente erlaubt");
        out(JSON.stringify(await readUsage((options.now ?? Date.now)(), { quietMissing: true }), null, 2));
        return 0;
      }
      case "set": {
        const flags = args.slice(1);
        // Gemischte Schalter sofort ablehnen, ohne auf die Standardeingabe zu warten.
        const stdin = flags.length === 1 && flags[0] === "--stdin"
          ? await (options.stdin ?? (() => Bun.stdin.text()))() : undefined;
        const now = (options.now ?? Date.now)();
        const { engine, windows } = parseExternalUsageArgs(flags, stdin, now);
        const active = windows.filter(window => window.resetsAt === undefined || Date.parse(window.resetsAt) > now);
        const result = await recordUsage(engine, active);
        const failed = result.rejected.some(entry => entry.reason !== "older");
        let applied: SwitchStateResult | undefined;
        let before: readonly SwitchBlock[] = [];
        if (!failed && active.length) {
          const usage = await readUsage(now, { quietMissing: true });
          const auto = (options.auto ?? engineAuto)();
          before = readSwitchState().blocks;
          // Die Mutation bleibt synchron und rein, auch beim Nachholen nach einer Sperre.
          const mutate = (state: Parameters<typeof applyMeasurement>[0]) => applyMeasurement(state, usage, now, auto);
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await (options.wait ?? Bun.sleep)(1_000);
            applied = await (options.updateState ?? updateSwitchState)(mutate);
            if (applied.persisted) break;
          }
        }
        const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        for (const window of windows) {
          const rejection = result.rejected.find(entry => entry.id === window.id);
          const status = !active.includes(window) ? "nicht übernommen, die Reset-Zeit ist vorbei"
            : rejection?.reason === "older" ? "nicht übernommen, es gibt eine jüngere Messung"
            : rejection ? "nicht gespeichert" : "übernommen";
          out(`${engine} ${window.id}: ${window.percent} %, ${status}`);
          if (applied?.persisted && active.includes(window)) {
            const matching = (block: SwitchBlock) => block.engine === engine && block.window === window.id
              && Date.parse(block.until) > now;
            const change = blockChange(before.filter(matching), applied.state.blocks.filter(matching), timeZone);
            if (change) out(change);
          }
        }
        if (applied && !applied.persisted) {
          out("Messwert gespeichert. Der Sperrzustand ließ sich gerade nicht schreiben; der Bot wertet den Messwert mit der nächsten Nachricht aus.");
        }
        return failed ? 1 : 0;
      }
      default: throw new Error("Befehl: limits set --engine <motor> --window <kennung> --percent <zahl>, set --stdin oder show erwartet");
    }
  } catch (error) {
    err(`Fehler: ${error instanceof Error ? error.message : "Eingabe konnte nicht gelesen werden"}`);
    return 1;
  }
}
