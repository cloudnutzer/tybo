/**
 * Test-Schritt nur für die Tests von Issue #161: nutzt alle neuen Teile des
 * Einrichtungsmodells (Standardwert, Auswahl vom Anbieter, transientes Feld,
 * Ablauf mit Plan, Fortschritt und Abbruch). Kein echter Schritt nutzt das
 * bisher; der Datenbank-Schritt folgt in #163 und #164.
 *
 * Alles ist Attrappe: der „Anbieter“ ist eine Funktion, gewartet wird über
 * ctx.sleep (in Tests sofort), geschrieben wird in die .env des Testordners.
 */

import type { SetupContext } from "../src/setup/context";
import type { ApplyResult, ChoicesResult, RunEvent, RunReport, SetupField, SetupStep, SetupValues, StepId } from "../src/setup/model";
import { fieldStates, stateFromCount } from "../src/setup/model";
import { envValues, invalid, writeEnv } from "../src/setup/steps/common";

export const FLOW_ID = "testablauf" as StepId;

/** Testwerte, keine echten Zugangsdaten */
export const FLOW = {
  token: "flow-token-geheim-4711",
  otherToken: "flow-token-anders-0815",
  password: "flow-einmal-passwort-99",
  org: "org-alpha",
  orgLabel: "Alpha GmbH",
};

export const FLOW_FIELDS: SetupField[] = [
  {
    name: "FLOW_MODE",
    label: "Art",
    kind: "choice",
    help: "Neu anlegen oder vorhandenes eintragen.",
    required: true,
    default: "neu",
    choices: [
      { value: "neu", label: "Neu anlegen" },
      { value: "vorhanden", label: "Vorhandenes eintragen" },
    ],
  },
  { name: "FLOW_TOKEN", label: "Zugangstoken", kind: "secret", help: "Token des Anbieters.", required: true },
  {
    name: "FLOW_ORG",
    label: "Organisation",
    kind: "choice",
    help: "Organisation beim Anbieter.",
    required: true,
    visible: v => v.FLOW_MODE === "neu",
    choicesFrom: async () => ({ choices: [] }),
  },
  { name: "FLOW_NAME", label: "Projektname", kind: "text", help: "Name des Projekts.", default: "tybo", visible: v => v.FLOW_MODE === "neu" },
  { name: "FLOW_PASSWORD", label: "Datenbank-Passwort", kind: "secret", help: "Nur für diesen Lauf.", transient: true, visible: v => v.FLOW_MODE === "neu" },
];

export const ENV_NAMES = ["FLOW_TOKEN", "FLOW_ORG", "FLOW_NAME"];

export interface FlowOptions {
  /** Antwort des Anbieters auf choicesFrom */
  choices?(values: SetupValues, ctx: SetupContext): Promise<ChoicesResult>;
  /** Eigener Ablauf statt des Standards */
  run?(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult>;
  /** Eigenes Speichern im Felder-Modus statt des Standards */
  apply?(values: SetupValues, ctx: SetupContext): Promise<ApplyResult>;
  /** Eigene Moduswahl und eigener Plan statt der Standards */
  runWhen?(values: SetupValues): boolean;
  plan?(values: SetupValues): string[];
  /** Felder abwandeln (etwa Sichtbarkeit abhängig von Text) */
  fields?(fields: SetupField[]): SetupField[];
}

export interface FlowLog {
  choicesCalls: SetupValues[];
  runs: SetupValues[];
  events: RunEvent[];
  signals: AbortSignal[];
}

/**
 * Standardablauf: drei Teilschritte, dazwischen Warten (mit waitedMs),
 * am Ende Schreiben über writeEnv. Bricht an den sicheren Stellen ab.
 */
export function makeFlowStep(options: FlowOptions = {}, log: FlowLog = { choicesCalls: [], runs: [], events: [], signals: [] }): SetupStep & { log: FlowLog } {
  const baseFields = FLOW_FIELDS.map(f =>
    f.name === "FLOW_ORG"
      ? {
          ...f,
          choicesFrom: async (values: SetupValues, ctx: SetupContext) => {
            log.choicesCalls.push({ ...values });
            if (options.choices) return options.choices(values, ctx);
            return { choices: [{ value: FLOW.org, label: FLOW.orgLabel }, { value: "org-beta", label: "Beta AG" }] };
          },
        }
      : f,
  );
  const fields = options.fields ? options.fields(baseFields) : baseFields;
  const step: SetupStep & { log: FlowLog } = {
    log,
    id: FLOW_ID,
    title: "Testablauf",
    description: "Nur für Tests.",
    optional: true,
    fields,
    async status(ctx) {
      const existing = await envValues(ctx, ENV_NAMES);
      const done = existing.FLOW_TOKEN ? 1 : 0;
      return { state: stateFromCount(done, 1), detail: done ? "Eingerichtet." : "Noch nicht eingerichtet.", fields: fieldStates(fields, existing) };
    },
    async test(values, ctx) {
      const existing = await envValues(ctx, ENV_NAMES);
      const problem = invalid(fields, values, existing);
      if (problem) return problem;
      return { ok: true, message: "Vorhandenes erreichbar." };
    },
    async apply(values, ctx) {
      if (options.apply) return options.apply(values, ctx);
      const existing = await envValues(ctx, ENV_NAMES);
      const problem = invalid(fields, values, existing);
      if (problem) return { ok: false, message: problem.message, changed: [] };
      return writeEnv(ctx, values.FLOW_TOKEN ? [["FLOW_TOKEN", values.FLOW_TOKEN]] : []);
    },
    runWhen: options.runWhen ?? (v => v.FLOW_MODE === "neu"),
    plan: options.plan ?? (() => ["Projekt beim Anbieter anlegen.", "Warten, bis das Projekt bereit ist.", "Zugangsdaten in die .env schreiben."]),
    async run(values, ctx, report, signal) {
      log.runs.push({ ...values });
      log.signals.push(signal);
      const tracked: RunReport = e => {
        log.events.push(e);
        report(e);
      };
      if (options.run) return options.run(values, ctx, tracked, signal);
      return defaultFlowRun(values, ctx, tracked, signal);
    },
  };
  return step;
}

export const ABORTED_MESSAGE = "Abgebrochen. Das Projekt ist angelegt, aber noch nicht eingetragen. Weiter mit: tybo setup testablauf, der Assistent ergänzt nur, was fehlt.";

export async function defaultFlowRun(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult> {
  report({ at: 1, total: 3, label: "Lege das Projekt an" });
  if (signal.aborted) return { ok: false, message: "Abgebrochen, noch nichts angelegt.", changed: [] };
  for (let waited = 0; waited <= 40_000; waited += 5_000) {
    report({ at: 2, total: 3, label: "Warte, bis das Projekt bereit ist", waitedMs: waited });
    await ctx.sleep(5_000, signal);
    if (signal.aborted) return { ok: false, message: ABORTED_MESSAGE, changed: [] };
  }
  report({ at: 3, total: 3, label: "Schreibe die Zugangsdaten" });
  const changes: Array<[string, string]> = [["FLOW_TOKEN", values.FLOW_TOKEN ?? ""], ["FLOW_ORG", values.FLOW_ORG ?? ""], ["FLOW_NAME", values.FLOW_NAME ?? ""]];
  const result = await writeEnv(ctx, changes.filter(([, v]) => v));
  if (!result.ok) return result;
  return { ok: true, message: "Projekt angelegt und eingetragen.", changed: result.changed };
}
