/**
 * Schritt „modelle“: Standardmodell, Standard-Effort und Fallback-Kette.
 *
 * Geschrieben wird config/settings.json (Schema aus src/lib/settings.ts),
 * weil die Laufzeit dort zuerst nachsieht: für Agenten-Modelle gibt es keine
 * Stufe in .env, und gespeicherte Fallback-Werte übersteuern .env. Vorhandene
 * Einstellungen (Agenten, Aux-Modelle) bleiben unberührt. Nur der
 * OpenRouter-Schlüssel landet in .env. Modell-Strings im Code ändert der
 * Schritt nicht; leere Felder heißen „Standard aus dem Code behalten“.
 * Scheitert danach die .env, nennt die Meldung die schon gespeicherte
 * settings.json.
 */

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../../lib/atomic-file";
import { EFFORT_LEVELS, settingsSchema, type EffortLevel, type Settings } from "../../lib/settings";
import type { SetupContext } from "../context";
import {
  enteredValues,
  fieldStates,
  mergeValues,
  type SetupField,
  type SetupStep,
  type SetupValues,
  type StatusItem,
} from "../model";
import { envValues, invalid, writeEnv, writeProblem } from "./common";

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$/;
const modelRule = (label: string) => (v: string) => (MODEL_NAME.test(v) ? null : `${label}: ungültiger Modellname`);

export const MODEL_FIELDS: SetupField[] = [
  {
    name: "DEFAULT_MODEL",
    label: "Standardmodell (optional)",
    kind: "text",
    help: "Claude-Modell für alle Agenten ohne eigene Einstellung. Leer lassen: Standard aus dem Code.",
    link: "https://docs.anthropic.com/en/docs/about-claude/models",
    validate: modelRule("Standardmodell"),
  },
  {
    name: "DEFAULT_EFFORT",
    label: "Standard-Effort (optional)",
    kind: "choice",
    help: "Wie gründlich Claude nachdenkt. Höher ist langsamer und teurer.",
    choices: EFFORT_LEVELS.map(e => ({ value: e, label: e })),
  },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter-Schlüssel (optional)",
    kind: "secret",
    help: "Cloud-Fallback, wenn Claude nicht antwortet.",
    link: "https://openrouter.ai/keys",
  },
  {
    name: "OPENROUTER_MODEL",
    label: "OpenRouter-Modell (optional)",
    kind: "text",
    help: "Modell für den Cloud-Fallback, etwa anbieter/modell.",
    link: "https://openrouter.ai/models",
    validate: modelRule("OpenRouter-Modell"),
  },
  {
    name: "OLLAMA_MODEL",
    label: "Ollama-Modell (optional)",
    kind: "text",
    help: "Lokales Modell als letzter Rückfall, vorher mit „ollama pull <modell>“ laden.",
    link: "https://ollama.com/library",
    validate: modelRule("Ollama-Modell"),
  },
  {
    name: "FALLBACK_OFFLINE_ONLY",
    label: "Nur lokal zurückfallen",
    kind: "yesno",
    help: "Ja: OpenRouter nie nutzen, nur Ollama.",
  },
];

type ReadSettings = { ok: true; settings: Settings } | { ok: false };

async function readSettings(path: string): Promise<ReadSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, settings: {} };
    return { ok: false };
  }
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, settings: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function existingValues(ctx: SetupContext): Promise<{ values: SetupValues; settings: ReadSettings }> {
  const env = await envValues(ctx, ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OLLAMA_MODEL", "FALLBACK_OFFLINE_ONLY"]);
  const settings = await readSettings(ctx.settingsPath);
  const s = settings.ok ? settings.settings : {};
  const values: SetupValues = {};
  const put = (name: string, v: string | boolean | undefined) => {
    if (v !== undefined && v !== "") values[name] = String(v);
  };
  put("DEFAULT_MODEL", s.defaults?.model);
  put("DEFAULT_EFFORT", s.defaults?.effort);
  put("OPENROUTER_API_KEY", env.OPENROUTER_API_KEY);
  // Wie fallback-llm.ts: Einstellungsdatei vor .env
  put("OPENROUTER_MODEL", s.fallback?.openrouterModel ?? env.OPENROUTER_MODEL);
  put("OLLAMA_MODEL", s.fallback?.ollamaModel ?? env.OLLAMA_MODEL);
  const offlineEnv = env.FALLBACK_OFFLINE_ONLY?.toLowerCase();
  put("FALLBACK_OFFLINE_ONLY", s.fallback?.offlineOnly ?? (offlineEnv ? offlineEnv === "true" : undefined));
  return { values, settings };
}

/** Überträgt die Eingaben in die Einstellungen; alles andere bleibt */
export function mergeSettings(settings: Settings, entered: SetupValues): Settings {
  const next: Settings = structuredClone(settings);
  if (entered.DEFAULT_MODEL || entered.DEFAULT_EFFORT) {
    next.defaults = { ...next.defaults };
    if (entered.DEFAULT_MODEL) next.defaults.model = entered.DEFAULT_MODEL;
    if (entered.DEFAULT_EFFORT) next.defaults.effort = entered.DEFAULT_EFFORT as EffortLevel;
  }
  if (entered.OPENROUTER_MODEL || entered.OLLAMA_MODEL || entered.FALLBACK_OFFLINE_ONLY) {
    next.fallback = { ...next.fallback };
    if (entered.OPENROUTER_MODEL) next.fallback.openrouterModel = entered.OPENROUTER_MODEL;
    if (entered.OLLAMA_MODEL) next.fallback.ollamaModel = entered.OLLAMA_MODEL;
    if (entered.FALLBACK_OFFLINE_ONLY) next.fallback.offlineOnly = entered.FALLBACK_OFFLINE_ONLY === "true";
  }
  return next;
}

export const modelsStep: SetupStep = {
  id: "modelle",
  title: "Modelle und Fallback",
  description: "Welches Claude-Modell antwortet und was einspringt, wenn Claude nicht erreichbar ist.",
  optional: true,
  fields: MODEL_FIELDS,

  async status(ctx) {
    const { values, settings } = await existingValues(ctx);
    const fields = fieldStates(MODEL_FIELDS, values);
    if (!settings.ok) {
      return { state: "teilweise", detail: "config/settings.json ist ungültig, der Bot nutzt die letzte gültige Fassung.", fields };
    }
    const any = MODEL_FIELDS.some(f => values[f.name]);
    return any
      ? { state: "erledigt", detail: "Modelle oder Fallback sind eingestellt.", fields }
      : { state: "fehlt", detail: "Nichts eingestellt, es gelten die Standardwerte.", fields };
  },

  async test(values, ctx) {
    const { values: existing } = await existingValues(ctx);
    const problem = invalid(MODEL_FIELDS, values, existing);
    if (problem) return problem;
    const merged = mergeValues(existing, values);
    const offline = merged.FALLBACK_OFFLINE_ONLY === "true";
    const items: StatusItem[] = [];
    if (merged.OPENROUTER_API_KEY && !offline) {
      const r = await ctx.providers.openrouterKey(merged.OPENROUTER_API_KEY);
      items.push({ label: "OpenRouter", ok: r.ok, detail: r.message });
    }
    if (merged.OLLAMA_MODEL || offline) {
      const r = await ctx.providers.ollamaTags();
      let ok = r.ok;
      let detail = r.message;
      const model = merged.OLLAMA_MODEL;
      if (r.ok && model && !(r.models ?? []).some(m => m === model || m === `${model}:latest`)) {
        ok = false;
        detail = `Ollama läuft, das Modell ${model} fehlt aber. Laden mit: ollama pull ${model}`;
      }
      items.push({ label: "Ollama", ok, detail, fix: ok || !model ? undefined : `ollama pull ${model}` });
    }
    if (items.length === 0) return { ok: true, message: "Nichts zu testen: kein Fallback eingestellt, es gelten die Standardwerte." };
    const ok = items.every(i => i.ok);
    return { ok, message: items.map(i => i.detail).join(" "), items };
  },

  async apply(values, ctx) {
    const { values: existing, settings } = await existingValues(ctx);
    const problem = invalid(MODEL_FIELDS, values, existing);
    if (problem) return { ...problem, changed: [] };
    const entered = enteredValues(values);
    const changed: string[] = [];

    const touchesSettings = MODEL_FIELDS.some(f => f.name !== "OPENROUTER_API_KEY" && entered[f.name]);
    if (touchesSettings) {
      if (!settings.ok) {
        return { ok: false, message: "config/settings.json ist ungültig. Bitte erst reparieren oder in der WebUI neu speichern; nichts wurde geändert.", changed: [] };
      }
      const next = mergeSettings(settings.settings, entered);
      if (JSON.stringify(next) !== JSON.stringify(settings.settings)) {
        try {
          await atomicWriteFile(ctx.settingsPath, JSON.stringify(settingsSchema.parse(next), null, 2) + "\n");
          changed.push(ctx.settingsPath);
        } catch (e) {
          return { ok: false, message: writeProblem("config/settings.json", e), changed: [] };
        }
      }
    }

    if (entered.OPENROUTER_API_KEY) {
      const env = await writeEnv(ctx, [["OPENROUTER_API_KEY", entered.OPENROUTER_API_KEY]], changed.length ? ["config/settings.json"] : []);
      if (!env.ok) return { ...env, changed };
      changed.push(...env.changed);
    }
    return { ok: true, message: changed.length ? "Gespeichert." : "Nichts zu ändern.", changed };
  },

  async savedValues(ctx) {
    return (await existingValues(ctx)).values;
  },
};
