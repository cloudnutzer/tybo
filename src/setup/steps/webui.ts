/**
 * Schritt „webui“: Browser-Zugang an oder aus, Passwort, Erreichbarkeit.
 * Die Regeln kommen aus src/web/config.ts (mindestens 12 Zeichen, gezählt in
 * Unicode-Codepoints, Standard nur dieser Rechner). WEB_* darf nur hier und
 * im Terminal gesetzt werden (Entscheidung 0011); die Schlüssel-Seite der
 * WebUI sperrt sie weiter.
 */

import { DEFAULT_WEB_HOST, loadWebConfig, MIN_PASSWORD_LENGTH } from "../../web/config";
import { fieldStates, mergeValues, type SetupField, type SetupStep, type SetupValues } from "../model";
import { enteredChanges, envValues, invalid, writeEnv } from "./common";

const enabled = (v: SetupValues) => v.WEB_ENABLED === "true";

export const WEBUI_FIELDS: SetupField[] = [
  {
    name: "WEB_ENABLED",
    label: "WebUI einschalten",
    kind: "yesno",
    required: true,
    help: "Chat und Einstellungen im Browser, im selben Prozess wie der Bot.",
  },
  {
    name: "WEB_PASSWORD",
    label: "Passwort der WebUI",
    kind: "secret",
    required: true,
    help: `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen. Damit meldest du dich im Browser an.`,
    visible: enabled,
    validate: v => ([...v].length >= MIN_PASSWORD_LENGTH ? null : `Passwort ist kürzer als ${MIN_PASSWORD_LENGTH} Zeichen`),
  },
  {
    name: "WEB_HOST",
    label: "Erreichbar von",
    kind: "choice",
    help: "Nur dieser Rechner ist am sichersten. Heimnetz erlaubt das Handy im selben WLAN.",
    choices: [
      { value: DEFAULT_WEB_HOST, label: "Nur dieser Rechner" },
      { value: "0.0.0.0", label: "Heimnetz" },
    ],
    visible: enabled,
  },
  {
    name: "WEB_PORT",
    label: "Port (optional)",
    kind: "text",
    help: "Standard 3100.",
    visible: enabled,
    validate: v => (/^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : "Port muss eine Zahl von 1 bis 65535 sein"),
  },
];

const NAMES = WEBUI_FIELDS.map(f => f.name);

export const webuiStep: SetupStep = {
  id: "webui",
  title: "WebUI",
  description: "Optional: mit dem Bot im Browser chatten, auch vom Handy im Heimnetz.",
  optional: true,
  fields: WEBUI_FIELDS,

  async status(ctx) {
    const existing = await envValues(ctx, NAMES);
    const fields = fieldStates(WEBUI_FIELDS, existing);
    const config = loadWebConfig(existing);
    if (config.status === "disabled") return { state: "fehlt", detail: "WebUI ist aus.", fields };
    if (config.status === "invalid") return { state: "teilweise", detail: `WebUI startet nicht: ${config.reason}.`, fields };
    return { state: "erledigt", detail: "WebUI ist an.", fields };
  },

  async apply(values, ctx) {
    const existing = await envValues(ctx, NAMES);
    const problem = invalid(WEBUI_FIELDS, values, existing);
    if (problem) return { ...problem, changed: [] };
    const merged = mergeValues(existing, values);
    const config = loadWebConfig(merged);
    if (config.status === "invalid") return { ok: false, message: config.reason, changed: [] };
    return writeEnv(ctx, enteredChanges(WEBUI_FIELDS, values, merged));
  },
};
