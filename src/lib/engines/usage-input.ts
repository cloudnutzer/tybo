/** Reine Prüfung externer Messwerte; erst der Befehl schreibt die geprüfte Eingabe. */
import { z } from "zod";
import { FUTURE_TOLERANCE_MS, isUsageWindowId, type UsageWindow } from "./usage";

const timestamp = z.string().datetime({ offset: true, message: "ISO-Zeit mit Z oder Zeitzonen-Offset erwartet" })
  .refine(value => Number.isFinite(Date.parse(value)), "ungültige Zeit");
const inputSchema = z.object({
  engine: z.enum(["claude", "codex"], { errorMap: () => ({ message: "claude oder codex erwartet" }) }),
  windows: z.array(z.object({
    id: z.string(),
    percent: z.number({ invalid_type_error: "Zahl von 0 bis 100 erwartet" }).finite().min(0).max(100),
    resetsAt: timestamp.optional(),
    measuredAt: timestamp,
  }).strict()).min(1, "mindestens ein Fenster erforderlich").max(10, "höchstens 10 Fenster erlaubt"),
}).strict();

export interface ExternalUsageInput {
  engine: "claude" | "codex";
  windows: UsageWindow[];
}

export function validateExternalUsage(input: unknown, now: number): ExternalUsageInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".");
    if (issue.code === "unrecognized_keys") {
      throw new Error(`${[field, ...issue.keys].filter(Boolean).join(".")}: unbekanntes Feld`);
    }
    throw new Error(`${field || "JSON"}: ${issue.message}`);
  }
  const { engine, windows } = parsed.data;
  const seen = new Set<string>();
  for (const [index, window] of windows.entries()) {
    const field = `windows.${index}`;
    if (!isUsageWindowId(window.id) || !(window.id === "weekly_all" || window.id === "session"
      || (engine === "claude" ? /^weekly_scoped:[a-z0-9-]+$/.test(window.id) : window.id.startsWith("window_")))) {
      throw new Error(`${field}.id: unbekannte Kennung für ${engine}`);
    }
    if (window.id === "window_300" || window.id === "window_10080") {
      throw new Error(`${field}.id: für Codex ${window.id === "window_300" ? "session" : "weekly_all"} verwenden`);
    }
    if (seen.has(window.id)) throw new Error(`${field}.id: Kennung doppelt`);
    seen.add(window.id);
    if (Date.parse(window.measuredAt) > now + FUTURE_TOLERANCE_MS) {
      throw new Error(`${field}.measuredAt: höchstens 60 Sekunden in der Zukunft erlaubt`);
    }
  }
  return { engine, windows: windows.map(window => ({ ...window, id: window.id as UsageWindow["id"], source: "extern" })) };
}

/** Beide Eingabeformen werden vor jedem Dateizugriff vollständig geprüft. */
export function parseExternalUsageArgs(args: readonly string[], stdin: string | undefined, now: number): ExternalUsageInput {
  if (args.includes("--stdin")) {
    if (args.length !== 1) throw new Error("--stdin: nicht mit anderen Schaltern kombinierbar");
    let input: unknown;
    try { input = JSON.parse(stdin ?? ""); } catch { throw new Error("JSON: ungültiges JSON in der Standardeingabe"); }
    return validateExternalUsage(input, now);
  }
  const fields: Record<string, string> = {
    "--engine": "engine", "--window": "id", "--percent": "percent",
    "--resets-at": "resetsAt", "--measured-at": "measuredAt",
  };
  const values: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const field = Object.hasOwn(fields, flag) ? fields[flag] : undefined;
    if (!field) throw new Error(`${flag}: unbekannter Schalter`);
    if (Object.hasOwn(values, field)) throw new Error(`${flag}: Schalter doppelt`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${field}: Wert fehlt (${flag})`);
    if (field === "percent") {
      if (value !== value.trim() || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
        throw new Error("percent: Dezimalzahl von 0 bis 100 erwartet");
      }
      values[field] = Number(value);
    } else values[field] = value;
  }
  const { engine, ...window } = values;
  return validateExternalUsage({ engine, windows: [{ ...window, measuredAt: window.measuredAt ?? new Date(now).toISOString() }] }, now);
}
