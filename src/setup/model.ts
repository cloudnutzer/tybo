/**
 * Einrichtung (M8, Entscheidung 0011): Schritte als Daten.
 *
 * Ein Schritt beschreibt, was er prüft (status), abfragt (fields), testet
 * (test) und schreibt (apply). Terminal und Browser zeigen nur diese Daten an,
 * damit beide Oberflächen nie auseinanderlaufen. Die Liste der Schritte steht
 * in src/setup/steps.ts.
 *
 * Regeln für alle Schritte:
 * - status() gibt nie gespeicherte Werte zurück, auch keine harmlosen, nur
 *   „gesetzt“ oder „nicht gesetzt“.
 * - Ein leeres Eingabefeld heißt „vorhandenen Wert behalten“. So löscht ein
 *   erneutes Einrichten keine Geheimnisse, die man nicht noch einmal eintippt.
 * - test(werte) prüft die eingegebenen, noch nicht gespeicherten Werte,
 *   ergänzt um vorhandene; Ergebnis in Klartext, ohne Geheimnisse.
 * - apply(werte) schreibt nur nach bestandener Prüfregel; Fehlermeldungen
 *   enthalten nie Werte.
 *
 * Erweiterungen aus Issue #161 (Grundlage für das Anlegen der Datenbank):
 * - default: Vorschlag, der nur greift, wenn weder eingegeben noch
 *   vorhanden. resolveValues() löst Eingabe > vorhandener Wert > Standard auf;
 *   Terminal und Browser geben die aufgelösten Werte an test/apply/run.
 * - choicesFrom: Auswahlliste vom Anbieter. Sie bekommt die schon
 *   eingegebenen Werte der Felder davor und ergänzt Vorhandenes selbst (wie
 *   test). Die Oberfläche merkt sich die geladene Liste je Sitzung, Schritt
 *   und wirksamen Werten davor (choicesKey) und prüft die Auswahl dagegen,
 *   auch eine schon gespeicherte.
 * - transient: gilt nur für diesen Lauf. Kein Schritt schreibt solche Werte,
 *   writeEnv() weist sie ab, status() meldet sie nie als gesetzt, und sie
 *   werden geschwärzt wie geheime Werte.
 * - run/runWhen/plan: Ablauf statt „Verbindungstest, dann Speichern“. Ohne
 *   runWhen läuft ein Schritt mit run immer als Ablauf. run() schreibt selbst
 *   (writeEnv) und testet am Ende selbst; Fortschritt nur in festen Sätzen
 *   aus dem Code, Abbruch über signal an sicheren Stellen.
 */

import { createHash } from "node:crypto";
import type { SetupContext } from "./context";

export const STEP_IDS = [
  "voraussetzungen",
  "telegram",
  "gruppe",
  "datenbank",
  "suche",
  "profil",
  "modelle",
  "webui",
  "zugang",
  "autostart",
  "pruefung",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export type StepState = "erledigt" | "fehlt" | "teilweise";

export type FieldKind = "text" | "secret" | "choice" | "yesno";

export interface FieldChoice {
  value: string;
  label: string;
}

/** Eingaben eines Schritts; Ja/Nein als "true"/"false" */
export type SetupValues = Record<string, string>;

export interface SetupField {
  /** Name der Variable in .env oder ein Schlüssel des Schritts */
  name: string;
  label: string;
  kind: FieldKind;
  /** Hilfetext in Klartext */
  help: string;
  /** Wo man den Wert bekommt */
  link?: string;
  /** Pflicht, wenn noch kein Wert vorhanden ist */
  required?: boolean;
  choices?: FieldChoice[];
  /**
   * Vorschlag ohne vorhandenen Wert: Enter (Terminal) bzw. vorausgefülltes
   * Feld (Browser). Bei choice eine der festen Auswahlen.
   */
  default?: string;
  /**
   * Auswahlliste vom Anbieter, abhängig von den schon eingegebenen Feldern
   * davor (etwa Organisationen zu einem Zugangstoken). Fehlertext in
   * Klartext, ohne Werte. Nur für kind "choice".
   */
  choicesFrom?(values: SetupValues, ctx: SetupContext): Promise<ChoicesResult>;
  /** Gilt nur für diesen Lauf: nie in .env, nie „gesetzt“, geschwärzt wie secret */
  transient?: true;
  /** Nur zeigen und prüfen, wenn das zutrifft (Werte: vorhandene plus eingegebene) */
  visible?(values: SetupValues): boolean;
  /** Prüfregel für einen nicht leeren Wert; Fehlertext ohne den Wert */
  validate?(value: string, values: SetupValues): string | null;
}

/** Zustand eines Felds: nur gesetzt oder nicht, nie der Wert */
export interface FieldState {
  name: string;
  set: boolean;
}

export interface StatusItem {
  label: string;
  ok: boolean;
  detail: string;
  /** Konkrete Anleitung, wenn etwas fehlt (etwa ein Befehl) */
  fix?: string;
}

export interface StepStatus {
  state: StepState;
  /** Ein Satz in Klartext */
  detail: string;
  fields: FieldState[];
  items?: StatusItem[];
}

export interface TestResult {
  ok: boolean;
  message: string;
  items?: StatusItem[];
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  /** Geänderte Variablennamen oder Dateipfade, nie Werte */
  changed: string[];
  /**
   * Nur Autostart (Issue #207): der Dienst läuft, auch wenn ok false ist
   * (etwa weil der Start ohne Anmeldung noch fehlt oder danach der
   * Supabase-Dienst scheiterte). Dann nicht zum Starten
   * von Hand auffordern.
   */
  running?: boolean;
}

export type ChoicesResult = { choices: FieldChoice[] } | { error: string };

/** Fortschritt eines Ablaufs: feste Sätze aus dem Code, nie Anbieter-Text */
export interface RunEvent {
  /** Teilschritt, ab 1 */
  at: number;
  total: number;
  label: string;
  detail?: string;
  /** Wie lange schon gewartet wird (bei langem Warten) */
  waitedMs?: number;
}

export type RunReport = (event: RunEvent) => void;

export interface SetupStep {
  id: StepId;
  title: string;
  description: string;
  /** Optional: darf übersprungen werden und zählt nicht für „fertig“ */
  optional: boolean;
  fields: SetupField[];
  status(ctx: SetupContext): Promise<StepStatus>;
  /**
   * Verbindungstest; fehlt bei Schritten ohne Gegenstelle. signal: Abbruch
   * (Strg+C); ein Test, der etwas anlegt, räumt danach trotzdem auf.
   */
  test?(values: SetupValues, ctx: SetupContext, signal?: AbortSignal): Promise<TestResult>;
  /** Schreiben; fehlt bei Schritten, die nichts schreiben */
  apply?(values: SetupValues, ctx: SetupContext): Promise<ApplyResult>;
  /**
   * Gespeicherte Werte, die nicht in .env stehen (config/settings.json,
   * config/profile.md). Nur für den Antwortfilter des Einrichtungsmodus.
   */
  savedValues?(ctx: SetupContext): Promise<SetupValues>;
  /**
   * Ablauf (Issue #161): ersetzt Test und Speichern, wenn runWhen zutrifft
   * (fehlt runWhen: immer). Schreibt selbst über writeEnv() und testet am
   * Ende selbst. Prüft signal zwischen den Teilschritten und beim Warten und
   * endet dann mit ok: false und einer Meldung, was schon erledigt ist und
   * wie es weitergeht.
   */
  run?(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult>;
  /** Werte: vorhandene plus eingegebene plus Standardwerte, wie bei visible */
  runWhen?(values: SetupValues): boolean;
  /** Was der Ablauf tun wird, feste Sätze ohne Werte */
  plan?(values: SetupValues): string[];
}

/** Läuft der Schritt mit diesen Werten als Ablauf? */
export function runsAsFlow(step: Pick<SetupStep, "run" | "runWhen">, merged: SetupValues): boolean {
  if (!step.run) return false;
  return step.runWhen ? step.runWhen(merged) : true;
}

// ---------------------------------------------------------------------------
// Werte
// ---------------------------------------------------------------------------

/** Platzhalter aus .env.example zählen nicht als gesetzt */
export function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.startsWith("your_") || v.includes("_here") || v === "your name";
}

/** Gesetzter Wert oder undefined (leer und Platzhalter zählen nicht) */
export function presentValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name]?.trim();
  return v && !isPlaceholder(v) ? v : undefined;
}

/** Eingaben ohne leere Felder, getrimmt */
export function enteredValues(values: SetupValues): SetupValues {
  const out: SetupValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) out[k] = t;
  }
  return out;
}

/** Vorhandene Werte, überlagert von den nicht leeren Eingaben */
export function mergeValues(existing: SetupValues, values: SetupValues): SetupValues {
  return { ...existing, ...enteredValues(values) };
}

/** Transiente Felder gelten nie als gesetzt, auch wenn der Name zufällig in der .env steht */
export function fieldStates(fields: SetupField[], existing: SetupValues): FieldState[] {
  return fields.map(f => {
    const v = existing[f.name];
    return { name: f.name, set: !f.transient && v !== undefined && v !== "" };
  });
}

// ---------------------------------------------------------------------------
// Transiente Namen
// ---------------------------------------------------------------------------

const transientNames = new Set<string>();

/**
 * Merkt sich die transienten Feldnamen der Schritte, damit writeEnv() sie
 * abweisen kann, ohne die Felddefinitionen zu kennen. steps.ts meldet alle
 * Schritte an, Terminal und Browser zusätzlich ihren Katalog (in Tests mit
 * eigenen Schritten). Ein Name bleibt gemerkt; ein Feld, das irgendwo
 * transient ist, darf nirgends in die .env.
 */
export function registerTransientFields(steps: Iterable<Pick<SetupStep, "fields">>): void {
  for (const step of steps) for (const f of step.fields) if (f.transient) transientNames.add(f.name);
}

export function isTransientName(name: string): boolean {
  return transientNames.has(name);
}

// ---------------------------------------------------------------------------
// Standardwerte
// ---------------------------------------------------------------------------

/**
 * Eingaben plus Standardwerte: ein Standard greift nur für ein sichtbares
 * Feld ohne Eingabe und ohne vorhandenen Wert. Der Reihe nach, damit ein
 * Standard einer Auswahl die Sichtbarkeit späterer Felder mitbestimmt.
 * Ergebnis wie eine Eingabe (getrimmt, ohne leere Felder).
 */
export function resolveValues(fields: SetupField[], values: SetupValues, existing: SetupValues): SetupValues {
  const out = enteredValues(values);
  for (const f of fields) {
    if (out[f.name] !== undefined || f.default === undefined) continue;
    if (existing[f.name] !== undefined && existing[f.name] !== "") continue;
    if (f.visible && !f.visible({ ...existing, ...out })) continue;
    const d = f.default.trim();
    if (d) out[f.name] = d;
  }
  return out;
}

/** Fehler in den Felddefinitionen selbst (für Tests): Standard einer Auswahl muss in der Liste stehen */
export function fieldDefinitionProblems(fields: SetupField[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (f.choicesFrom && f.kind !== "choice") out.push(`${f.name}: choicesFrom nur bei Auswahlfeldern`);
    if (f.default === undefined) continue;
    if (f.kind === "choice" && !f.choicesFrom && !f.choices?.some(c => c.value === f.default)) {
      out.push(`${f.name}: Standard ist keine der Auswahlen`);
    }
    if (f.kind === "choice" && f.choicesFrom) out.push(`${f.name}: Standard bei geladener Auswahl nicht möglich`);
    if (f.kind === "yesno" && f.default !== "true" && f.default !== "false") out.push(`${f.name}: Standard muss true oder false sein`);
    if (f.kind === "secret" || f.transient) out.push(`${f.name}: geheime oder transiente Felder haben keinen Standard`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prüfregeln
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;

/** Zuletzt geladene Auswahllisten (choicesFrom), je Feldname */
export type LoadedChoices = Record<string, FieldChoice[] | undefined>;

/**
 * Prüft die Eingaben eines Schritts gegen seine Felder. existing sind die
 * vorhandenen Werte; ein Pflichtfeld ist erfüllt, wenn es eingegeben,
 * schon vorhanden oder durch einen Standard belegt ist.
 *
 * loaded: die geladenen Auswahllisten der Oberfläche. Ist es angegeben,
 * muss der wirksame Wert eines sichtbaren choicesFrom-Felds (Eingabe, sonst
 * der vorhandene) in der geladenen Liste stehen (fehlt die Liste: Fehler).
 * Ohne loaded (Aufruf im Schritt selbst) prüft der Schritt nur Form und
 * Zeilenumbrüche; die Liste kennt nur die Oberfläche.
 */
export function validateValues(fields: SetupField[], values: SetupValues, existing: SetupValues, loaded?: LoadedChoices): FieldErrors {
  const entered = resolveValues(fields, values, existing);
  const merged = { ...existing, ...entered };
  const errors: FieldErrors = {};
  for (const f of fields) {
    if (f.visible && !f.visible(merged)) continue;
    const v = entered[f.name];
    if (v === undefined) {
      if (f.required && !existing[f.name]) errors[f.name] = `${f.label} fehlt`;
      // Eine gespeicherte Auswahl vom Anbieter gilt nur, wenn sie in der aktuellen Liste steht
      else if (loaded && f.choicesFrom && existing[f.name]) {
        const problem = loadedChoiceProblem(f, existing[f.name], loaded);
        if (problem) errors[f.name] = problem;
      }
      continue;
    }
    if (f.kind === "yesno" && v !== "true" && v !== "false") {
      errors[f.name] = `${f.label}: bitte ja oder nein`;
      continue;
    }
    if (f.kind === "choice" && f.choicesFrom) {
      const problem = loaded ? loadedChoiceProblem(f, v, loaded) : null;
      if (problem) {
        errors[f.name] = problem;
        continue;
      }
    } else if (f.kind === "choice" && !f.choices?.some(c => c.value === v)) {
      errors[f.name] = `${f.label}: keine gültige Auswahl`;
      continue;
    }
    if (/[\r\n\0]/.test(v)) {
      errors[f.name] = `${f.label}: Zeilenumbrüche sind nicht erlaubt`;
      continue;
    }
    const problem = f.validate?.(v, merged);
    if (problem) errors[f.name] = problem;
  }
  return errors;
}

function loadedChoiceProblem(f: SetupField, value: string, loaded: LoadedChoices): string | null {
  const list = loaded[f.name];
  if (!list) return `${f.label}: Auswahl bitte erst laden`;
  if (!list.some(c => c.value === value)) return `${f.label}: keine gültige Auswahl`;
  return null;
}

/**
 * Wovon eine geladene Auswahlliste abhängt: die Werte der Felder vor diesem
 * Feld, als Hash (die Werte selbst werden nie gespeichert). values sind die
 * wirksamen Werte, also vorhandene überlagert von Eingaben und Standards:
 * ändert sich etwa das Token, eingegeben oder gespeichert, passt die alte
 * Liste nicht mehr.
 */
export function choicesKey(fields: SetupField[], fieldName: string, values: SetupValues): string {
  const entered = enteredValues(values);
  const before: Array<[string, string]> = [];
  for (const f of fields) {
    if (f.name === fieldName) break;
    if (entered[f.name] !== undefined) before.push([f.name, entered[f.name]]);
  }
  return createHash("sha256").update(JSON.stringify(before)).digest("hex");
}

/** Die eingegebenen Werte der Felder vor fieldName (für choicesFrom) */
export function valuesBefore(fields: SetupField[], fieldName: string, values: SetupValues): SetupValues {
  const entered = enteredValues(values);
  const out: SetupValues = {};
  for (const f of fields) {
    if (f.name === fieldName) break;
    if (entered[f.name] !== undefined) out[f.name] = entered[f.name];
  }
  return out;
}

export function errorsMessage(errors: FieldErrors): string {
  return Object.values(errors).join("; ");
}

// ---------------------------------------------------------------------------
// Geheimnisse aus Texten halten
// ---------------------------------------------------------------------------

/**
 * Ersetzt jedes Vorkommen der Geheimnisse durch ***, auch in Adressen
 * (Telegram hat das Token im Pfad). Kürzt lange Texte, damit keine rohen
 * Anbieter-Antworten durchrutschen.
 */
export function redact(text: string, secrets: Array<string | undefined>, max = 200): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join("***");
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join("***");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Werte ab dieser Länge werden überall ersetzt; kürzere nur als eigenes Wort */
export const SHORT_VALUE = 4;

/** Werte und ihre URL-kodierte Form, die längsten zuerst */
function maskForms(values: Iterable<string | undefined>): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    forms.add(v);
    const encoded = encodeURIComponent(v);
    if (encoded !== v) forms.add(encoded);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * Ersetzt Werte durch ***: ab SHORT_VALUE Zeichen überall, kürzere nur, wo
 * sie für sich stehen (nicht zwischen Buchstaben oder Ziffern). Kann also
 * kurze Werte mitten in anderen Zeichen stehen lassen; containsValue() sagt,
 * ob danach noch einer drinsteht.
 */
export function maskStandalone(text: string, values: Iterable<string | undefined>): string {
  let out = text;
  for (const v of maskForms(values)) {
    if (v.length >= SHORT_VALUE) out = out.split(v).join("***");
    else out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, "gu"), "***");
  }
  return out;
}

/** Steht einer der Werte (oder seine URL-kodierte Form) irgendwo im Text? */
export function containsValue(text: string, values: Iterable<string | undefined>): boolean {
  return maskForms(values).some(v => text.includes(v));
}

/**
 * Ersetzt jeden Wert (und seine URL-kodierte Form) durch ***, ohne
 * Mindestlänge und überall: erst wie maskStandalone(), dann auch kurze
 * Werte mitten in anderen Zeichen (aus „xq7x“ wird „x***x“). Lässt Leerraum
 * und Länge sonst unverändert (Terminal-Zeilen behalten ihre Einrückung).
 */
export function maskValues(text: string, values: Iterable<string | undefined>): string {
  const forms = maskForms(values);
  let out = maskStandalone(text, forms);
  for (const v of forms) out = out.split(v).join("***");
  return out;
}

// ---------------------------------------------------------------------------
// Gesamtstatus
// ---------------------------------------------------------------------------

export interface OverallStatus {
  /** Alle Pflichtschritte erledigt und mindestens ein Kanal bereit */
  complete: boolean;
  /** Pflichtschritte, die noch nicht erledigt sind */
  missing: StepId[];
  /** Optionale Schritte, die weder erledigt noch übersprungen sind */
  open: StepId[];
  skipped: StepId[];
  /**
   * Kanalregel (Issue #228, src/setup/channels.ts): null ohne Prüfung (etwa
   * eigene Schrittkataloge in Tests), sonst bereit oder nicht, mit Satz
   */
  channels: OverallChannels | null;
}

export interface OverallChannels {
  ready: boolean;
  /** Warum nicht bereit (Kanal-Satz, halbes Telegram, ungültige WebUI) bzw. was läuft */
  message: string;
  telegram: boolean;
  webui: boolean;
}

/**
 * Gesamtstatus über alle Schritte außer „pruefung“ (die fasst selbst
 * zusammen). Überspringen gilt nur für optionale Schritte; ein
 * übersprungener Pflichtschritt bleibt fehlend. „teilweise“ zählt nicht als
 * erledigt. Seit Issue #228 ist Telegram optional; stattdessen gilt die
 * Kanalregel (channels): ohne bereiten Kanal ist die Einrichtung nie
 * fertig, auch nicht mit übersprungenem Telegram-Schritt.
 */
export function overallStatus(
  steps: ReadonlyArray<Pick<SetupStep, "id" | "optional">>,
  states: Partial<Record<StepId, StepState>>,
  skipped: Iterable<StepId> = [],
  channels: OverallChannels | null = null,
): OverallStatus {
  const skip = new Set(skipped);
  const missing: StepId[] = [];
  const open: StepId[] = [];
  const skippedOut: StepId[] = [];
  for (const step of steps) {
    if (step.id === "pruefung") continue;
    const done = states[step.id] === "erledigt";
    if (!step.optional) {
      if (!done) missing.push(step.id);
    } else if (!done) {
      if (skip.has(step.id)) skippedOut.push(step.id);
      else open.push(step.id);
    }
  }
  const channelsReady = channels ? channels.ready : true;
  return { complete: missing.length === 0 && channelsReady, missing, open, skipped: skippedOut, channels };
}

/** Status aus der Anzahl erfüllter Teile */
export function stateFromCount(done: number, total: number): StepState {
  if (done >= total) return "erledigt";
  return done === 0 ? "fehlt" : "teilweise";
}
