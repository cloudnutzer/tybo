/** Reine Motoranzeige: nur übergebene Daten, Zeitzone und Uhrzeit; keine Dienste. */
import { BRAND } from "../brand";
import type { EnginePreview, EnginePreviewStage } from "./engine-choice";
import type { StageStatus } from "./engine-stage-view";
import { windowCounts } from "./engine-switch";
import { formatShortSwitchTime, formatSwitchTime, switchWindowLabel } from "./engine-switch-text";
import type { UsageReading } from "./engines/usage";

export const MOTOR_TEXT = {
  unavailable: "Die Motor-Wahl ist hier nicht verfügbar.",
  usage: "Wechseln: /motor claude · /motor codex · /motor opencode · /motor api · /motor standard · Werkzeuge: /motor werkzeuge\nNeu messen: /motor pruefen · Automatik: /motor auto an, /motor auto aus",
  busy: "In diesem Gespräch läuft gerade eine Antwort. Erst /stop, dann /motor.",
  fileInvalid: "config/settings.json ist ungültig, der Motor wurde nicht geändert. Bitte die Datei reparieren oder löschen.",
  notSaved: "Der Motor konnte nicht gespeichert werden.",
  newSession: "Das beginnt eine neue Session; die letzten Nachrichten gehen mit.",
  claudeNotReady: `Bis das behoben ist, antworten höchstens Ersatzmodelle, falls eingerichtet. Mehr zeigt ${BRAND.cli} pruefen.`,
  noBackups: "Ersatzstufen: keine eingestellt (WebUI, Modelle, Abschnitt Motor)",
  backupsMissing: "Noch ist keine Ersatzstufe eingestellt (WebUI, Modelle, Abschnitt Motor).",
  fallback: "Danach: Ersatzmodelle mit eingeschränktem Werkzeugumfang",
  autoUsage: "Möglich: /motor auto an oder /motor auto aus.",
  autoOff: "Automatik aus: An der Schwelle wird nicht mehr gewechselt, Sperren wegen der Schwelle sind aufgehoben. Nach einem Limit-Fehler oder Ausfall springt weiter die nächste Stufe ein.",
  nextRun: "Ob das Limit wirklich frei ist, zeigt der nächste Lauf.",
  standardOrder: "Es gilt wieder die Reihenfolge aus den Einstellungen.",
} as const;

const MOTOR_SOURCE_TEXT = {
  agent: "für diesen Agenten eingestellt",
  topic: "mit /motor für dieses Gespräch gesetzt", settings: "Standard aus den Einstellungen",
  env: "Standard aus TYBO_ENGINE in .env", code: "eingebauter Standard",
} as const;

function thresholdDetail(status: StageStatus): string {
  const window = status.window ? switchWindowLabel(status.window) : undefined;
  const percent = status.percent === undefined ? undefined : `${Math.round(status.percent)} %`;
  return window && percent ? `${window}: ${percent}` : window ?? percent ?? "Schwelle erreicht";
}

/** Verbindlicher Zustandstext, bewusst getrennt von Stand und Alter einer Messung. */
export function motorStageStateText(status: StageStatus, timeZone: string): string {
  if (status.state === "answering") return "antwortet";
  if (status.state === "free") return "frei";
  if (status.state !== "blocked") return `nicht bereit${status.message ? ` (${status.message})` : ""}`;
  const reset = status.resetKnown && status.cause !== "outage";
  const time = formatShortSwitchTime(status.blockedUntil, timeZone, reset);
  const detail = status.cause === "outage" ? "Ausfall" : status.cause === "limit" ? "Limit erreicht" : thresholdDetail(status);
  return `${reset ? "gesperrt" : "pausiert"} bis ${time} (${detail}${!reset && status.cause !== "outage" ? ", Reset unbekannt" : ""})`;
}

export function motorReasonText(stage: EnginePreviewStage, timeZone: string): string {
  const short = motorStageStateText(stage, timeZone);
  if (stage.state !== "blocked") return `${stage.label} ist ${short}`;
  const time = formatShortSwitchTime(stage.blockedUntil, timeZone, stage.resetKnown && stage.cause !== "outage");
  return `${stage.label} ist ${short.replace(`bis ${time}`, `bis ${formatSwitchTime(stage.blockedUntil, timeZone)} Uhr`)}`;
}

function measuredAge(reading: UsageReading, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(reading.measuredAt)) / 60_000));
  if (!minutes) return "gerade gemessen";
  if (minutes < 60) return `gemessen vor ${minutes} Min.`;
  if (minutes < 1440) return `gemessen vor ${Math.floor(minutes / 60)} Std.`;
  return `gemessen vor ${Math.floor(minutes / 1440)} Tagen`;
}

/** Sperrfenster, sonst höchster bekannter Stand der für die Stufe zählenden Fenster. */
function stageReading(stage: EnginePreviewStage, now: number): Extract<UsageReading, { state: "known" }> | undefined {
  const known = stage.windows.filter((reading): reading is Extract<UsageReading, { state: "known" }> => reading.state === "known"
    && (!reading.resetsAt || Date.parse(reading.resetsAt) > now) && windowCounts(stage, stage.model, reading.id));
  if (stage.state === "blocked" && stage.window) return known.find(reading => reading.id === stage.window);
  return known.sort((a, b) => b.percent - a.percent || Date.parse(b.measuredAt) - Date.parse(a.measuredAt))[0];
}

function stageLine(stage: EnginePreviewStage, timeZone: string, now: number): string {
  let state = motorStageStateText(stage, timeZone);
  const reading = stageReading(stage, now);
  const details: string[] = [];
  if (reading) {
    if (!(stage.state === "blocked" && stage.cause === "threshold" && stage.window === reading.id && stage.percent !== undefined)) {
      details.push(`${switchWindowLabel(reading.id)}: ${Math.round(reading.percent)} %`);
      if (reading.resetsAt) details.push(`Reset ${formatShortSwitchTime(reading.resetsAt, timeZone)}`);
    }
    details.push(measuredAge(reading, now));
  } else if (stage.engine === "opencode" && stage.model?.startsWith("openrouter/")) details.push("zahlt je Verbrauch");
  if (details.length) state = state.endsWith(")") ? `${state.slice(0, -1)}, ${details.join(", ")})` : `${state} (${details.join(", ")})`;
  return `${stage.label}${stage.model ? ` · ${stage.model}` : ""}: ${state}`;
}

export function motorNotReadyNote(preview: EnginePreview, engine: string): string {
  const status = preview.available.find(entry => entry.engine === engine);
  if (!status || status.ready) return "";
  const why = status.message ? ` (${status.message})` : "";
  if (engine === "claude") return `\n${status.label} ist gerade nicht bereit${why}. ${MOTOR_TEXT.claudeNotReady}`;
  return `\n${status.label} ist gerade nicht bereit${why}, bis dahin antwortet Claude Code.`;
}

/** Telegram-Grenze mit Reserve; normale Anzeigen behalten alle Zeilen. */
export function limitMotorText(text: string): string {
  return text.length <= 4000 ? text : `${text.slice(0, 3970)}\nWeitere Angaben gekürzt.`;
}

export function motorStatusText(preview: EnginePreview & { toolLines?: readonly string[] }, timeZone: string, now: number): string {
  const label = (engine: string) => preview.available.find(entry => entry.engine === engine)?.label
    ?? preview.stages.find(stage => stage.engine === engine)?.label ?? engine;
  const availability = (entries: EnginePreview["available"]) => entries.map(entry => entry.ready
    ? `${entry.label} ✓` : `${entry.label} (${entry.message ?? "nicht bereit"})`).join(", ");
  if (!preview.hasBackups) return limitMotorText([
    `Motor dieses Gesprächs: ${label(preview.configured.engine)} (${MOTOR_SOURCE_TEXT[preview.configured.source]})`,
    `Standard: ${label(preview.standard.engine)} (${MOTOR_SOURCE_TEXT[preview.standard.source]})`,
    `Verfügbar: ${availability(preview.available)}`, MOTOR_TEXT.noBackups, MOTOR_TEXT.usage,
  ].join("\n") + motorNotReadyNote(preview, preview.configured.engine) + (preview.toolLines?.length ? `\n${preview.toolLines.join("\n")}` : ""));
  const roles = { first: preview.configured.source === "agent" ? MOTOR_SOURCE_TEXT.agent : "antwortet", backup: "springt ein", manual: "von Hand gewählt", none: "keiner frei" };
  const lines = [`Motor in diesem Gespräch: ${preview.answering ? `${preview.answering.label} (${roles[preview.role]})` : "keiner frei"}`];
  if (!preview.answering) lines.push("Grund: " + (preview.earliestFree
    ? `Bis ${formatSwitchTime(preview.earliestFree, timeZone)} Uhr antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.`
    : "Es antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang."));
  else if (preview.reason) lines.push(`Grund: ${motorReasonText(preview.reason, timeZone)}`);
  lines.push("", "Reihenfolge", ...preview.stages.map((stage, index) => `${index + 1}. ${stageLine(stage, timeZone, now)}`), MOTOR_TEXT.fallback);
  const others = preview.available.filter(entry => !preview.stages.some(stage => stage.engine === entry.engine));
  if (others.length) lines.push(`Außerdem wählbar: ${availability(others)}`);
  if (preview.toolLines?.length) lines.push("", ...preview.toolLines);
  lines.push("", `Automatik: ${preview.auto.enabled ? "an" : "aus"}, Wechsel ab ${preview.auto.threshold} %, zurück unter ${preview.auto.returnBelow} %`, MOTOR_TEXT.usage);
  return limitMotorText(lines.join("\n"));
}
