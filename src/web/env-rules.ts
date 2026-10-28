/**
 * Regeln für Namen und Werte in .env (Issue #62), ohne Dateizugriff. Liegt in
 * src/web, damit der Web-Server nichts außerhalb von src/web lädt;
 * src/lib/env-file.ts nutzt dieselben Regeln beim Schreiben.
 */

/** Gültige Namen für neue Einträge, vollständig verankert */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Obergrenze für einen Wert in Zeichen */
export const MAX_ENV_VALUE_LENGTH = 8192;

/** Grund der Ablehnung oder null. Nennt nie den Wert. */
export function envValueProblem(value: unknown): string | null {
  if (typeof value !== "string") return "Der Wert muss Text sein";
  if (value.length === 0) return "Der Wert ist leer";
  if (value.length > MAX_ENV_VALUE_LENGTH) return `Der Wert ist länger als ${MAX_ENV_VALUE_LENGTH} Zeichen`;
  if (/[\r\n]/.test(value)) return "Zeilenumbrüche sind im Wert nicht erlaubt";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "Steuerzeichen sind im Wert nicht erlaubt";
  return null;
}
