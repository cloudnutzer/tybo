/**
 * Die Schritte der Einrichtung in ihrer Reihenfolge (Entscheidung 0011).
 * Terminal (`tybo setup`) und Browser (Einrichtungsmodus) zeigen genau
 * diese Liste; das Modell steht in src/setup/model.ts.
 *
 * Pflicht: voraussetzungen, telegram, datenbank, profil, autostart.
 * Optional (überspringbar): gruppe, modelle, webui. „pruefung“ fasst am Ende
 * zusammen und schreibt nichts.
 */

import { readSetupEnv, type SetupContext } from "./context";
import { overallStatus, presentValue, registerTransientFields, type SetupStep, type SetupValues, type StatusItem, type StepId, type StepState } from "./model";
import { autostartStep } from "./steps/autostart";
import { databaseStep, setupPath } from "./steps/database";
import { modelsStep } from "./steps/models";
import { prerequisitesStep } from "./steps/prerequisites";
import { profileStep } from "./steps/profile";
import { groupStep, telegramStep } from "./steps/telegram";
import { webuiStep } from "./steps/webui";

const STEPS_BEFORE_CHECK: SetupStep[] = [
  prerequisitesStep,
  telegramStep,
  groupStep,
  databaseStep,
  profileStep,
  modelsStep,
  webuiStep,
  autostartStep,
];

async function allStates(ctx: SetupContext, skipped: Iterable<StepId>) {
  const states: Partial<Record<StepId, StepState>> = {};
  const items: StatusItem[] = [];
  for (const step of STEPS_BEFORE_CHECK) {
    const status = await step.status(ctx);
    states[step.id] = status.state;
    items.push({ label: step.title, ok: status.state === "erledigt", detail: status.detail });
  }
  return { states, items, overall: overallStatus(STEPS_BEFORE_CHECK, states, skipped) };
}

function titleOf(id: StepId): string {
  return STEPS_BEFORE_CHECK.find(s => s.id === id)?.title ?? id;
}

/** Gesamtprüfung: Status aller Schritte, beim Test zusätzlich deren Verbindungstests */
export const checkStep: SetupStep = {
  id: "pruefung",
  title: "Gesamtprüfung",
  description: "Fasst zusammen, was eingerichtet ist und was noch fehlt.",
  optional: false,
  fields: [],

  async status(ctx) {
    const { overall, items } = await allStates(ctx, []);
    return {
      state: overall.complete ? "erledigt" : "fehlt",
      detail: overall.complete
        ? "Alle Pflichtschritte sind erledigt."
        : `Es fehlt noch: ${overall.missing.map(titleOf).join(", ")}.`,
      fields: [],
      items,
    };
  },

  /** Testet jeden eingerichteten Schritt mit den gespeicherten Werten */
  async test(_values, ctx) {
    const { states, overall } = await allStates(ctx, []);
    const items: StatusItem[] = [];
    for (const step of STEPS_BEFORE_CHECK) {
      if (!step.test || states[step.id] !== "erledigt") continue;
      const result = await step.test({}, ctx);
      items.push({ label: step.title, ok: result.ok, detail: result.message });
    }
    const failed = items.filter(i => !i.ok);
    const ok = overall.complete && failed.length === 0;
    const parts: string[] = [];
    if (!overall.complete) parts.push(`Es fehlt noch: ${overall.missing.map(titleOf).join(", ")}.`);
    if (failed.length) parts.push(`Fehlgeschlagen: ${failed.map(i => i.label).join(", ")}.`);
    return { ok, message: ok ? "Alles eingerichtet und erreichbar." : parts.join(" "), items };
  },
};

export const SETUP_STEPS: readonly SetupStep[] = [...STEPS_BEFORE_CHECK, checkStep];
// writeEnv() weist transiente Namen ab (Issue #161)
registerTransientFields(SETUP_STEPS);

export function getStep(id: string): SetupStep | undefined {
  return SETUP_STEPS.find(s => s.id === id);
}

/**
 * Vorhandene Werte der Felder eines Schritts (.env, dazu was der Schritt
 * woanders speichert; beim Datenbank-Schritt der vorgewählte Weg, siehe
 * setupPath: nicht die Laufzeit-Datenbank, sondern etwa supabase-cloud), nie
 * transiente. Terminal und Browser werten Sichtbarkeit, Standardwerte,
 * runWhen und plan auf diesen Werten plus den Eingaben aus (Issue #161).
 * Nur intern: geht nie an die Oberfläche.
 */
export async function existingFieldValues(step: SetupStep, ctx: SetupContext): Promise<SetupValues> {
  const env = await readSetupEnv(ctx);
  const elsewhere = step.savedValues ? await step.savedValues(ctx).catch(() => ({}) as SetupValues) : {};
  const out: SetupValues = {};
  for (const f of step.fields) {
    if (f.transient) continue;
    const v = presentValue(env, f.name) ?? presentValue(elsewhere, f.name);
    if (v !== undefined) out[f.name] = v;
  }
  if (step.id === "datenbank") {
    const path = setupPath(out);
    if (path) out.DB_BACKEND = path;
  }
  return out;
}

/** Gesamtstatus aller Schritte; skipped nur für optionale Schritte wirksam */
export async function setupOverview(ctx: SetupContext, skipped: Iterable<StepId> = []) {
  return (await allStates(ctx, skipped)).overall;
}
