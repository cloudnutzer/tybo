/**
 * `tybo setup` im Terminal (Issue #65, Entscheidung 0011): führt durch die
 * Schritte aus src/setup/steps.ts. Die Schritte selbst (prüfen, abfragen,
 * testen, schreiben) stehen im Kern; hier ist nur die Oberfläche.
 *
 *   tybo setup             Übersicht, dann die offenen Schritte der Reihe
 *                           nach; erledigte nur, wenn man sie auswählt
 *   tybo setup <schritt>   nur dieser Schritt, auch wenn er erledigt ist
 *   tybo setup --liste     nur die Übersicht: schreibt nichts, testet nichts
 *
 * Ablauf eines Schritts: Felder abfragen (geheime verdeckt, Enter behält
 * einen gesetzten Wert), dann der Verbindungstest mit den noch nicht
 * gespeicherten Eingaben, dann eine Zusammenfassung ohne Werte und die
 * Bestätigung, erst danach schreibt der Kern. Schlägt der Test oder das
 * Schreiben fehl: erneut eingeben oder überspringen.
 *
 * Abbrechen (Strg+C): Während Eingabe, Test und Bestätigung ist noch nichts
 * geschrieben, die .env bleibt, wie sie zu Beginn des Schritts war. Kommt
 * Strg+C während des Schreibens, läuft das Schreiben zu Ende (jede Datei
 * wird atomar ersetzt) und die Einrichtung endet danach. Abgeschlossene
 * Schritte bleiben gespeichert. Profil und Modelle schreiben zwei Dateien
 * nacheinander; ein Rückbau über beide gibt es nicht, der Kern meldet, was
 * schon gespeichert ist, und die Abbruchmeldung nennt es ebenso.
 *
 * Gesamtprüfung: Schlägt der Test eines eingerichteten Schritts mit den
 * gespeicherten Werten fehl, bietet tybo für diesen Schritt erneute Eingabe
 * (bzw. Prüfung) oder ausdrückliches Überspringen an. Was danach noch
 * fehlschlägt, steht in der Zusammenfassung.
 *
 * Autostart startet den Bot sofort über launchd oder PM2. Deshalb fragt
 * dieser Schritt ausdrücklich nach, Standard ist Nein.
 *
 * Abläufe (Issue #161): Trifft runWhen eines Schritts zu, ersetzt der Ablauf
 * Test und Speichern. tybo zeigt den Plan, fragt „Jetzt ausführen? [J/n]“
 * und gibt je Fortschritt eine Zeile aus (bei langem Warten höchstens alle
 * 15 s). Strg+C löst dann das signal des Ablaufs aus, wartet höchstens 30 s
 * auf dessen Ende und zeigt seine Meldung; danach endet die Einrichtung. Hört
 * der Ablauf nicht auf, endet sie trotzdem, aber erst nach einem
 * angefangenen Schreiben der .env (waitForEnvWrites).
 *
 * Felder mit Standard zeigen ihn in Klammern, Enter übernimmt ihn (nur ohne
 * vorhandenen Wert). Auswahlen vom Anbieter (choicesFrom) lädt tybo, wenn
 * es an das Feld kommt, und zeigt sie nummeriert wie feste.
 */

import { networkInterfaces } from "node:os";
import { BRAND } from "../brand";
import { loadWebConfig } from "../web/config";
import { readSetupEnv, type SetupContext } from "./context";
import {
  enteredValues,
  maskValues,
  registerTransientFields,
  runsAsFlow,
  valuesBefore,
  type ApplyResult,
  type FieldChoice,
  type RunEvent,
  type SetupField,
  type SetupStep,
  type SetupValues,
  type StatusItem,
  type StepId,
  type StepState,
  type StepStatus,
  type TestResult,
} from "./model";
import { SetupAbort, type Prompter } from "./prompt";
import { checkStep, existingFieldValues, getStep, SETUP_STEPS, setupOverview } from "./steps";
import { pendingSafetyWarnings, waitForEnvWrites, waitForSafetyWork } from "./steps/common";

export { SetupAbort } from "./prompt";

export interface SetupUiOptions {
  ctx: SetupContext;
  prompter: Prompter;
  out(line: string): void;
  /** Strg+C als Signal (außerhalb einer Raw-Eingabe); gibt die Abmeldung zurück */
  onInterrupt?(handler: () => void): () => void;
  /** Adressen dieses Rechners im Heimnetz (Standard: Netzwerkkarten) */
  lanAddresses?(): string[];
  /** Nur für Tests: eigener Schrittkatalog (Standard: SETUP_STEPS) */
  steps?: readonly SetupStep[];
  /** Nur für Tests: Schonfrist nach Strg+C (Standard: RUN_GRACE_MS) */
  runGraceMs?: number;
}

/** So lange wartet tybo nach Strg+C auf das Ende eines Ablaufs */
export const RUN_GRACE_MS = 30_000;
/** Bei langem Warten höchstens alle 15 s eine neue Zeile */
export const RUN_LINE_INTERVAL_MS = 15_000;

export type SetupArgs = { mode: "all" } | { mode: "list" } | { mode: "step"; step: StepId };
/** Aufruf von tybo setup: Terminal (SetupArgs) oder Browser (--web, Issue #66, src/setup/web-mode.ts) */
export type SetupCommand = SetupArgs | { mode: "web" };

/** Exit-Code nach Strg+C, wie in Shells üblich */
export const EXIT_ABORTED = 130;

const STEP_ORDER = SETUP_STEPS.filter(s => s.id !== "pruefung");

/** tybo setup [--liste | --web | <schritt>]; null bei allem anderen */
export function parseSetupArgs(args: string[]): SetupCommand | null {
  if (args.length === 0) return { mode: "all" };
  if (args.length !== 1) return null;
  const [arg] = args;
  if (arg === "--liste") return { mode: "list" };
  if (arg === "--web") return { mode: "web" };
  const step = getStep(arg.toLowerCase());
  return step ? { mode: "step", step: step.id } : null;
}

export function setupUsage(): string {
  return [
    `  ${BRAND.cli} setup             Einrichtung: Übersicht, dann die offenen Schritte`,
    `  ${BRAND.cli} setup <Schritt>   nur einen Schritt: ${SETUP_STEPS.map(s => s.id).join(", ")}`,
    `  ${BRAND.cli} setup --liste     nur die Übersicht (schreibt und testet nichts)`,
    `  ${BRAND.cli} setup --web       Einrichtung im Browser (nur dieser Rechner, mit Einmal-Code)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<StepState, string> = {
  erledigt: "erledigt ",
  teilweise: "teilweise",
  fehlt: "fehlt    ",
};

function stepTitle(step: SetupStep): string {
  return step.optional ? `${step.title} (optional)` : step.title;
}

/**
 * Ersetzt bekannte Geheimnisse durch ***, bevor irgendetwas ausgegeben wird:
 * auch URL-kodiert, ohne Mindestlänge und auch mitten in anderen Zeichen
 * (maskValues). Transiente Werte zählen wie geheime.
 */
class SafeOut {
  private secrets = new Set<string>();
  constructor(private write: (line: string) => void) {}
  addSecret(value: string | undefined) {
    const v = value?.trim();
    if (v) this.secrets.add(v);
  }
  line(text = "") {
    this.write(maskValues(text, this.secrets));
  }
}

/** m:ss für Wartezeiten */
export function formatWaited(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Eine Fortschrittszeile: [3/7] Warte, bis das Projekt bereit ist (1:20) */
export function formatRunEvent(e: RunEvent): string {
  const detail = e.detail ? `: ${e.detail}` : "";
  const waited = e.waitedMs !== undefined ? ` (${formatWaited(e.waitedMs)})` : "";
  return `[${e.at}/${e.total}] ${e.label}${detail}${waited}`;
}

function printItems(out: SafeOut, items: StatusItem[] | undefined, indent = "    ") {
  for (const item of items ?? []) {
    out.line(`${indent}${item.ok ? "ok " : "!! "} ${item.label}: ${item.detail}`);
    if (!item.ok && item.fix) out.line(`${indent}    So geht's: ${item.fix}`);
  }
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

type Outcome = "gespeichert" | "geprüft" | "unverändert" | "übersprungen";

class Interrupt {
  requested = false;
  private waiters: Array<() => void> = [];
  private listeners = new Set<() => void>();
  trigger() {
    this.requested = true;
    for (const w of this.waiters.splice(0)) w();
    for (const l of [...this.listeners]) l();
  }
  /** Ruft handler bei Strg+C auf (auch sofort, wenn schon ausgelöst); gibt die Abmeldung zurück */
  onTrigger(handler: () => void): () => void {
    if (this.requested) handler();
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  /** Wartet auf p, bricht bei Strg+C sofort ab */
  guard<T>(p: Promise<T>): Promise<T> {
    if (this.requested) return Promise.reject(new SetupAbort());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new SetupAbort());
      this.waiters.push(onAbort);
      p.then(
        v => {
          this.waiters = this.waiters.filter(w => w !== onAbort);
          resolve(v);
        },
        e => {
          this.waiters = this.waiters.filter(w => w !== onAbort);
          reject(e);
        },
      );
    });
  }
}

/** Felder von vorn abfragen; values übernimmt Enter */
class RestartCollect {
  constructor(readonly values: SetupValues) {}
}

/** Nach Strg+C während des Schreibens: das Schreiben ist zu Ende gelaufen */
class AbortAfterWrite extends SetupAbort {}

/** Nach Strg+C während eines Ablaufs; ended: der Ablauf hat innerhalb der Frist aufgehört */
class AbortAfterRun extends SetupAbort {
  constructor(readonly ended: boolean) {
    super();
  }
}

/** Was im laufenden Schritt schon geschrieben wurde, für die Abbruchmeldung */
interface WriteProgress {
  changed: string[];
  /** Das letzte Schreiben ist fehlgeschlagen */
  failed: boolean;
}

class SetupRun {
  readonly out: SafeOut;
  readonly interrupt = new Interrupt();
  readonly outcomes = new Map<StepId, Outcome>();
  /** Schreibstand des laufenden Schritts; null außerhalb eines Schritts */
  progress: WriteProgress | null = null;
  readonly steps: readonly SetupStep[];

  constructor(private options: SetupUiOptions) {
    this.out = new SafeOut(options.out);
    this.steps = options.steps ?? SETUP_STEPS;
    registerTransientFields(this.steps);
  }

  findStep(id: string): SetupStep | undefined {
    return this.steps.find(s => s.id === id);
  }

  get ctx() {
    return this.options.ctx;
  }

  ask(question: string, secret = false): Promise<string> {
    return this.interrupt.guard(this.options.prompter.ask(question, { secret }));
  }

  async askYesNo(question: string, fallback: boolean): Promise<boolean> {
    const hint = fallback ? "[J/n]" : "[j/N]";
    for (;;) {
      const answer = (await this.ask(`${question} ${hint} `)).trim().toLowerCase();
      if (answer === "") return fallback;
      const parsed = parseYesNo(answer);
      if (parsed !== undefined) return parsed === "true";
      this.out.line("Bitte j oder n eingeben.");
    }
  }

  /** Nach einem Fehlschlag: true = erneut, false = überspringen */
  async askRetry(retryLabel: string): Promise<boolean> {
    for (;;) {
      const answer = (await this.ask(`${retryLabel} [E] oder überspringen [ü]? `)).trim().toLowerCase();
      if (answer === "" || answer === "e") return true;
      if (answer === "ü" || answer === "u" || answer === "s") return false;
      this.out.line("Bitte e (erneut) oder ü (überspringen) eingeben.");
    }
  }

  /** Geheimnisse aus der .env vorab kennen, damit sie nie in der Ausgabe landen */
  async learnSecrets() {
    const env = await readSetupEnv(this.ctx).catch(() => ({}) as Record<string, string>);
    for (const step of this.steps) {
      for (const f of step.fields) if (f.kind === "secret" && !f.transient) this.out.addSecret(env[f.name]);
    }
    this.out.addSecret(env.WEB_PASSWORD);
  }

  async statuses(): Promise<Map<StepId, StepStatus>> {
    const map = new Map<StepId, StepStatus>();
    for (const step of STEP_ORDER) map.set(step.id, await this.interrupt.guard(step.status(this.ctx)));
    return map;
  }

  printOverview(statuses: Map<StepId, StepStatus>) {
    const width = Math.max(...STEP_ORDER.map(s => stepTitle(s).length));
    STEP_ORDER.forEach((step, i) => {
      const status = statuses.get(step.id)!;
      this.out.line(`  ${String(i + 1).padStart(2)}. ${stepTitle(step).padEnd(width)}  ${STATE_LABEL[status.state]}  ${status.detail}`);
      for (const item of status.items ?? []) {
        if (!item.ok && item.fix) this.out.line(`${" ".repeat(width + 8)}${item.label}: ${item.fix}`);
      }
    });
    this.out.line(`  ${String(STEP_ORDER.length + 1).padStart(2)}. ${checkStep.title.padEnd(width)}  läuft am Ende einer vollständigen Einrichtung`);
  }

  // -------------------------------------------------------------------------
  // Felder
  // -------------------------------------------------------------------------

  /**
   * Fragt die Felder ab; null heißt: Schritt überspringen. previous sind die
   * Eingaben des vorigen Versuchs (nach einem Fehlschlag); Enter übernimmt sie.
   * Lässt sich eine Auswahl vom Anbieter nicht laden und will man neu
   * eingeben, beginnt die Abfrage von vorn (Enter übernimmt das Eingegebene).
   */
  async collect(step: SetupStep, status: StepStatus, existing: SetupValues, previous: SetupValues = {}): Promise<SetupValues | null> {
    let prev = previous;
    for (;;) {
      const outcome = await this.collectOnce(step, status, existing, prev);
      if (!(outcome instanceof RestartCollect)) return outcome;
      prev = outcome.values;
    }
  }

  /**
   * existing: die vorhandenen Werte (existingFieldValues); visible und
   * validate sehen sie wie im Browser, ausgegeben werden sie nie
   */
  private async collectOnce(step: SetupStep, status: StepStatus, existing: SetupValues, previous: SetupValues): Promise<SetupValues | RestartCollect | null> {
    const setNames = new Set(status.fields.filter(f => f.set).map(f => f.name));
    const known = existing;
    const values: SetupValues = {};

    for (const baseField of step.fields) {
      if (baseField.visible && !baseField.visible({ ...known, ...enteredValues(values) })) continue;
      let field = baseField;
      if (baseField.choicesFrom) {
        const loaded = await this.loadChoices(baseField, step, values);
        if (!loaded) {
          if (await this.askRetry("Nochmal eingeben")) return new RestartCollect({ ...previous, ...values });
          return null;
        }
        field = { ...baseField, choices: loaded };
      }
      const has = setNames.has(field.name);
      // Auswahl und Ja/Nein steuern, welche Felder folgen; Pflicht-Auswahlen
      // werden deshalb immer neu beantwortet (der Kern verrät den alten Wert nicht)
      const mustAnswer = !!field.required && (field.kind === "choice" || field.kind === "yesno");
      let prev: string | undefined = previous[field.name];
      // Eine alte Auswahl, die in der neu geladenen Liste fehlt, gilt nicht mehr
      if (prev !== undefined && field.choicesFrom && !field.choices?.some(c => c.value === prev)) prev = undefined;
      // Standard nur ohne vorhandenen Wert und ohne Eingabe vom vorigen Versuch;
      // eine Auswahl vom Anbieter mit genau einem Eintrag ist vorausgewählt (Issue #163)
      const single = field.choicesFrom && field.choices?.length === 1 ? field.choices[0].value : undefined;
      const suggestion = field.default !== undefined && field.default.trim() !== "" ? field.default.trim() : single;
      const fallback = prev === undefined && !has ? suggestion : undefined;
      for (;;) {
        this.printField(field, has, mustAnswer, prev !== undefined, fallback !== undefined);
        const raw = await this.ask(`${field.label}${fallback !== undefined ? ` [${defaultLabel(field, fallback)}]` : ""}: `, field.kind === "secret");
        const parsed = parseAnswer(field, raw);
        let problem: string | null = null;
        if (parsed === undefined) {
          problem = field.kind === "yesno" ? `${field.label}: bitte j oder n` : `${field.label}: keine gültige Auswahl`;
        } else if (parsed === "") {
          if (prev !== undefined) {
            values[field.name] = prev;
            break;
          }
          if (fallback !== undefined) {
            values[field.name] = fallback;
            break;
          }
          if (field.required && (!has || mustAnswer)) problem = `${field.label} fehlt`;
          // Eine gespeicherte Auswahl vom Anbieter gilt nur, wenn sie in der neu geladenen Liste steht
          else if (has && field.choicesFrom && known[field.name] !== undefined && !field.choices?.some(c => c.value === known[field.name])) {
            problem = `${field.label}: keine gültige Auswahl`;
          }
        } else {
          if (field.kind === "secret" || field.transient) this.out.addSecret(parsed);
          const merged = { ...known, ...enteredValues(values), [field.name]: parsed };
          problem = /[\r\n\0]/.test(parsed) ? `${field.label}: Zeilenumbrüche sind nicht erlaubt` : (field.validate?.(parsed, merged) ?? null);
        }
        if (!problem) {
          if (parsed) values[field.name] = parsed;
          break;
        }
        this.out.line(`  ${problem}`);
        if (!(await this.askYesNo("Nochmal eingeben?", true))) return null;
      }
    }
    return values;
  }

  /** Auswahl vom Anbieter; null nach einem Ladefehler (Meldung ist ausgegeben) */
  async loadChoices(field: SetupField, step: SetupStep, values: SetupValues): Promise<FieldChoice[] | null> {
    this.out.line();
    this.out.line(`  Lade die Auswahl für ${field.label} …`);
    let problem: string;
    try {
      const result = await this.interrupt.guard(field.choicesFrom!(valuesBefore(step.fields, field.name, values), this.ctx));
      if ("choices" in result && result.choices.length) return result.choices;
      problem = "error" in result ? result.error : "Der Anbieter hat keine Auswahl geliefert.";
    } catch (e) {
      if (e instanceof SetupAbort) throw e;
      problem = "Die Auswahl ließ sich nicht laden.";
    }
    this.out.line(`  ${field.label}: ${problem}`);
    return null;
  }

  printField(field: SetupField, has: boolean, mustAnswer: boolean, hasPrevious: boolean, hasDefault = false) {
    this.out.line();
    this.out.line(`  ${field.label}${field.kind === "secret" ? " (Eingabe bleibt unsichtbar)" : ""}`);
    this.out.line(`  ${field.help}`);
    if (field.link) this.out.line(`  Link: ${field.link}`);
    if (field.kind === "choice") {
      field.choices?.forEach((c, i) => this.out.line(`    ${i + 1}) ${c.label}`));
    }
    if (field.kind === "yesno") this.out.line("  Antwort: j oder n");
    if (hasPrevious) this.out.line("  Enter übernimmt deine Eingabe vom vorigen Versuch.");
    else if (hasDefault) this.out.line("  Enter übernimmt den Vorschlag in Klammern.");
    else if (has && mustAnswer) this.out.line("  Ist gesetzt; bitte trotzdem wählen.");
    else if (has) this.out.line("  Ist gesetzt. Enter behält den bisherigen Wert.");
    else if (!field.required) this.out.line("  Enter lässt es leer.");
  }

  // -------------------------------------------------------------------------
  // Schritte
  // -------------------------------------------------------------------------

  printTest(result: TestResult) {
    this.out.line(`  Verbindungstest: ${result.ok ? "bestanden" : "fehlgeschlagen"}. ${result.message}`);
    if (result.items && result.items.length > 1) printItems(this.out, result.items);
    else if (!result.ok) printItems(this.out, result.items?.filter(i => i.fix));
  }

  /** Zusammenfassung ohne Werte; bei Autostart eine ausdrückliche Warnung */
  printSummary(step: SetupStep, values: SetupValues) {
    this.out.line();
    if (step.id === "autostart") {
      const how = this.ctx.platform === "darwin" ? "launchd" : "PM2";
      this.out.line(`  Autostart einrichten (${how}): ${BRAND.name} startet dann sofort im Hintergrund`);
      this.out.line("  und künftig mit dem Rechner und nach Abstürzen von selbst.");
      this.out.line(`  Läuft ${BRAND.name} gerade schon in einem anderen Fenster (bun run start), dort erst beenden,`);
      this.out.line("  sonst holen sich zwei Bots dieselben Telegram-Nachrichten.");
      return;
    }
    const entered = enteredValues(values);
    const names = step.fields.filter(f => entered[f.name] !== undefined).map(f => f.label);
    this.out.line("  Zusammenfassung (ohne Werte):");
    if (names.length) this.out.line(`  Neu gesetzt: ${names.join(", ")}`);
    else this.out.line("  Keine neuen Eingaben; fehlende Teile werden aus den vorhandenen Werten ergänzt.");
    const kept = step.fields.filter(f => entered[f.name] === undefined && f.kind !== "choice" && f.kind !== "yesno");
    if (kept.length && names.length) this.out.line(`  Bleibt, wie es ist: ${kept.map(f => f.label).join(", ")}`);
  }

  /** Voraussetzungen und andere Schritte ohne Eingaben und ohne Schreiben: nur prüfen */
  async checkOnly(step: SetupStep): Promise<Outcome> {
    if (!step.test) return "unverändert";
    for (;;) {
      this.out.line("  Prüfe …");
      const result = await this.interrupt.guard(step.test({}, this.ctx));
      this.printTest(result);
      if (result.ok) return "geprüft";
      if (!(await this.askRetry("Nochmal prüfen"))) return "übersprungen";
    }
  }

  async runStep(step: SetupStep, position: string, chosen: boolean): Promise<Outcome> {
    this.progress = { changed: [], failed: false };
    // Nur bei normalem Ende zurücksetzen; beim Abbruch braucht runSetup den Stand
    const outcome = await this.runStepInner(step, position, chosen);
    this.progress = null;
    return outcome;
  }

  private async runStepInner(step: SetupStep, position: string, chosen: boolean): Promise<Outcome> {
    this.out.line();
    this.out.line(`${position}${stepTitle(step)}`);
    this.out.line(`  ${step.description}`);
    const status = await this.interrupt.guard(step.status(this.ctx));
    this.out.line(`  Stand: ${status.detail}`);

    if (step.optional && !chosen && !(await this.askYesNo("Jetzt einrichten?", true))) return "übersprungen";
    if (!step.apply && step.fields.length === 0) return this.checkOnly(step);

    let previous: SetupValues = {};
    for (;;) {
      // Sichtbarkeit, Standardwerte, runWhen und plan auf demselben Stand: vorhandene Werte plus Eingaben
      const existing = await this.interrupt.guard(existingFieldValues(step, this.ctx));
      const values = await this.collect(step, status, existing, previous);
      if (values === null) return "übersprungen";
      previous = values;
      const entered = enteredValues(values);

      const merged = { ...existing, ...entered };
      if (runsAsFlow(step, merged)) {
        const outcome = await this.runFlow(step, values, merged);
        if (outcome === "erneut") continue;
        return outcome;
      }

      if (step.test) {
        this.out.line();
        this.out.line("  Teste …");
        const result = await this.interrupt.guard(step.test(values, this.ctx));
        this.printTest(result);
        if (!result.ok) {
          if (await this.askRetry(step.fields.length ? "Erneut eingeben" : "Nochmal prüfen")) continue;
          return "übersprungen";
        }
      } else {
        this.out.line("  Für diesen Schritt gibt es keinen Verbindungstest.");
      }

      if (!step.apply) return "geprüft";
      if (Object.keys(entered).length === 0 && status.state === "erledigt") {
        this.out.line(step.fields.length ? "  Keine neuen Eingaben, alles bleibt, wie es ist." : "  Schon eingerichtet, nichts zu tun.");
        return "unverändert";
      }

      this.printSummary(step, values);
      const isAutostart = step.id === "autostart";
      const confirmed = await this.askYesNo(isAutostart ? "Autostart jetzt einrichten?" : "Speichern?", !isAutostart);
      if (!confirmed) {
        this.out.line("  Nicht gespeichert.");
        return "übersprungen";
      }

      // Nicht über guard: das Schreiben läuft auch nach Strg+C zu Ende
      const result = await step.apply(values, this.ctx);
      const progress = this.progress!;
      for (const c of result.changed) if (!progress.changed.includes(c)) progress.changed.push(c);
      progress.failed = !result.ok;
      this.out.line(`  ${result.message}`);
      if (result.changed.length) this.out.line(`  Geändert: ${result.changed.map(c => this.relative(c)).join(", ")}`);
      if (this.interrupt.requested) throw new AbortAfterWrite();
      if (result.ok) return result.changed.length ? "gespeichert" : "unverändert";
      if (!(await this.askRetry(step.fields.length ? "Erneut eingeben" : "Nochmal versuchen"))) return "übersprungen";
    }
  }

  /**
   * Ablauf statt Test und Speichern: Plan, eine Rückfrage, Fortschritt,
   * Ergebnis. "erneut": nach einem Fehlschlag neu eingeben.
   */
  async runFlow(step: SetupStep, values: SetupValues, merged: SetupValues): Promise<Outcome | "erneut"> {
    this.out.line();
    this.out.line("  Das passiert jetzt:");
    for (const sentence of step.plan?.(merged) ?? []) this.out.line(`    - ${sentence}`);
    if (!(await this.askYesNo("Jetzt ausführen?", true))) {
      this.out.line("  Nicht ausgeführt.");
      return "übersprungen";
    }
    this.out.line();
    const result = await this.executeRun(step, values);
    const progress = this.progress!;
    for (const c of result.changed) if (!progress.changed.includes(c)) progress.changed.push(c);
    progress.failed = !result.ok;
    this.out.line(`  ${result.message}`);
    if (result.changed.length) this.out.line(`  Geändert: ${result.changed.map(c => this.relative(c)).join(", ")}`);
    if (this.interrupt.requested) throw new AbortAfterRun(true);
    if (result.ok) return result.changed.length ? "gespeichert" : "unverändert";
    return (await this.askRetry("Erneut eingeben")) ? "erneut" : "übersprungen";
  }

  /** Führt run() aus; Strg+C löst signal aus und wartet höchstens RUN_GRACE_MS */
  private async executeRun(step: SetupStep, values: SetupValues): Promise<ApplyResult> {
    const controller = new AbortController();
    let lastAt = -1;
    let lastWaited = Number.NEGATIVE_INFINITY;
    const report = (e: RunEvent) => {
      const fresh = e.at !== lastAt || e.waitedMs === undefined || e.waitedMs - lastWaited >= RUN_LINE_INTERVAL_MS;
      if (!fresh) return;
      lastAt = e.at;
      lastWaited = e.waitedMs ?? Number.NEGATIVE_INFINITY;
      this.out.line(`  ${formatRunEvent(e)}`);
    };
    const running: Promise<ApplyResult> = step.run!(values, this.ctx, report, controller.signal).catch(e => ({
      ok: false,
      // Nur der Fehlername: Meldungen könnten Eingaben enthalten
      message: `Der Ablauf ist mit einem internen Fehler stehen geblieben (${e instanceof Error ? e.name : typeof e}).`,
      changed: [],
    }));
    let off: () => void = () => {};
    const interrupted = new Promise<"abbruch">(resolve => {
      off = this.interrupt.onTrigger(() => {
        controller.abort();
        resolve("abbruch");
      });
    });
    const first = await Promise.race([running, interrupted]);
    off();
    if (first !== "abbruch") return first;

    this.out.line("  Breche ab, warte auf das Ende des Ablaufs …");
    const graceMs = this.options.runGraceMs ?? RUN_GRACE_MS;
    const second = await this.raceGrace(running, graceMs);
    if (second !== "frist") return second;
    this.out.line(`  Der Ablauf hat nach ${graceMs / 1000} Sekunden noch nicht aufgehört.`);
    // Schutzschritte (Portprüfung, Schutz-Stopp) nie abschneiden: erst warnen, dann abwarten
    const warnings = pendingSafetyWarnings();
    if (warnings.length) {
      for (const w of warnings) this.out.line(`  ${w}`);
      this.out.line("  Warte, bis diese Prüfung fertig ist …");
      await waitForSafetyWork();
      // Danach meldet der Ablauf gleich sein Ergebnis (samt Ausgang des Schutz-Stopps)
      const third = await this.raceGrace(running, graceMs);
      if (third !== "frist") return third;
    }
    this.out.line("  Die Einrichtung endet trotzdem; ein angefangenes Schreiben der .env läuft vorher zu Ende.");
    await waitForEnvWrites();
    throw new AbortAfterRun(false);
  }

  private async raceGrace(running: Promise<ApplyResult>, graceMs: number): Promise<ApplyResult | "frist"> {
    const graceEnd = new AbortController();
    const grace = this.ctx.sleep(graceMs, graceEnd.signal).then(() => "frist" as const);
    const result = await Promise.race([running, grace]);
    graceEnd.abort();
    return result;
  }

  relative(path: string): string {
    const prefix = this.ctx.root.endsWith("/") ? this.ctx.root : `${this.ctx.root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  /**
   * Gesamtprüfung mit den gespeicherten Werten. Fehlgeschlagene Schritte
   * bietet sie zum erneuten Eingeben oder Prüfen an; gibt die Schritte
   * zurück, deren Test am Ende noch fehlschlägt.
   */
  async finalCheck(): Promise<StepId[]> {
    this.out.line();
    this.out.line(checkStep.title);
    const declined = new Set<StepId>();
    for (;;) {
      this.out.line("  Prüfe alle eingerichteten Schritte mit den gespeicherten Werten …");
      const result = await this.interrupt.guard(checkStep.test!({}, this.ctx));
      printItems(this.out, result.items);
      this.out.line(`  ${result.message}`);
      const failedTitles = new Set((result.items ?? []).filter(i => !i.ok).map(i => i.label));
      const failed = STEP_ORDER.filter(s => failedTitles.has(s.title));
      const open = failed.filter(s => !declined.has(s.id));
      if (open.length === 0) return failed.map(s => s.id);

      let redone = false;
      for (const step of open) {
        this.out.line();
        this.out.line(`  ${step.title}: Prüfung mit den gespeicherten Werten fehlgeschlagen.`);
        const retryLabel = step.fields.length ? `${step.title} erneut eingeben` : `${step.title} nochmal prüfen`;
        if (!(await this.askRetry(retryLabel))) {
          declined.add(step.id);
          continue;
        }
        const outcome = await this.runStep(step, "Erneut: ", true);
        if (outcome === "übersprungen") declined.add(step.id);
        else {
          this.outcomes.set(step.id, outcome);
          redone = true;
        }
      }
      if (!redone) return failed.map(s => s.id);
      this.out.line();
    }
  }

  // -------------------------------------------------------------------------
  // Ende
  // -------------------------------------------------------------------------

  async printEnd(skipped: StepId[], checkFailed: StepId[]) {
    const titleOf = (id: StepId) => getStep(id)?.title ?? id;
    const by = (o: Outcome) => [...this.outcomes].filter(([, v]) => v === o).map(([id]) => titleOf(id));
    this.out.line();
    this.out.line("Zusammenfassung");
    const saved = by("gespeichert");
    const unchanged = [...by("unverändert"), ...by("geprüft")];
    const skippedNow = by("übersprungen");
    this.out.line(`  Gespeichert: ${saved.length ? saved.join(", ") : "nichts"}`);
    if (unchanged.length) this.out.line(`  Geprüft, unverändert: ${unchanged.join(", ")}`);
    if (skippedNow.length) this.out.line(`  Übersprungen: ${skippedNow.join(", ")}`);
    if (checkFailed.length) this.out.line(`  Gesamtprüfung fehlgeschlagen: ${checkFailed.map(titleOf).join(", ")}`);

    const overall = await this.interrupt.guard(setupOverview(this.ctx, skipped));
    if (overall.missing.length) this.out.line(`  Noch offen (Pflicht): ${overall.missing.map(titleOf).join(", ")}`);
    else this.out.line("  Alle Pflichtschritte sind erledigt.");
    if (overall.open.length) this.out.line(`  Optional, noch nicht eingerichtet: ${overall.open.map(titleOf).join(", ")}`);

    this.out.line();
    this.out.line("Nächster Schritt");
    const needsSetup = overall.missing.filter(id => id !== "autostart");
    if (checkFailed.length) {
      this.out.line(`  Erst die fehlgeschlagene Prüfung beheben: ${checkFailed.map(id => `${BRAND.cli} setup ${id}`).join(", ")}`);
    }
    if (needsSetup.length) {
      this.out.line(`  Erst fertig einrichten: ${BRAND.cli} setup (oder einzeln: ${needsSetup.map(id => `${BRAND.cli} setup ${id}`).join(", ")})`);
    } else if (checkFailed.length) {
      // Kein „läuft, schreib deinem Bot“, solange eine Prüfung fehlschlägt
    } else if (!overall.missing.includes("autostart")) {
      this.out.line(`  ${BRAND.name} läuft über den Autostart. Schreib deinem Bot in Telegram.`);
    } else {
      this.out.line(`  Zum Ausprobieren starten: cd ${this.ctx.root} && bun run start`);
      this.out.line("  (läuft, bis das Fenster geschlossen wird)");
      this.out.line(`  Dauerhaft mit dem Rechner starten: ${BRAND.cli} setup autostart`);
    }
    await this.printWebHint();
  }

  async printWebHint() {
    const env = await readSetupEnv(this.ctx).catch(() => ({}) as Record<string, string>);
    const web = loadWebConfig(env);
    if (web.status === "disabled") {
      this.out.line(`  WebUI ist aus. Der Terminal-Chat (${BRAND.cli}) und der Browser brauchen sie: ${BRAND.cli} setup webui`);
      return;
    }
    if (web.status === "invalid") {
      this.out.line(`  WebUI startet so nicht: ${web.reason}. Korrigieren mit: ${BRAND.cli} setup webui`);
      return;
    }
    const { host, port } = web.config;
    const lan = host === "0.0.0.0" || host === "::";
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
    this.out.line(`  Bei laufendem Bot: Chat im Terminal mit ${BRAND.cli}`);
    if (lan || local) this.out.line(`  WebUI auf diesem Rechner: http://127.0.0.1:${port}`);
    if (lan) {
      const ips = (this.options.lanAddresses ?? defaultLanAddresses)();
      const where = ips.length ? ips.map(ip => `http://${ip}:${port}`).join(" oder ") : `http://<IP dieses Rechners>:${port}`;
      this.out.line(`  WebUI im Heimnetz (Handy im selben WLAN): ${where}`);
    }
    if (!lan && !local) {
      this.out.line(`  WebUI: http://${host}:${port}`);
      this.out.line(`  ${BRAND.cli} verbindet sich über 127.0.0.1; dafür WEB_HOST=0.0.0.0 wählen.`);
    }
  }
}

function defaultLanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out.slice(0, 2);
}

export function parseYesNo(answer: string): "true" | "false" | undefined {
  const a = answer.trim().toLowerCase();
  if (["j", "ja", "y", "yes"].includes(a)) return "true";
  if (["n", "nein", "no"].includes(a)) return "false";
  return undefined;
}

/** Anzeige eines Standards: bei Auswahlen die Beschriftung, sonst der Wert */
function defaultLabel(field: SetupField, value: string): string {
  if (field.kind === "yesno") return value === "true" ? "j" : "n";
  return field.choices?.find(c => c.value === value)?.label ?? value;
}

/** Eingabe zu Feldwert: "" = leer, undefined = ungültig */
export function parseAnswer(field: SetupField, raw: string): string | undefined {
  const answer = raw.trim();
  if (answer === "") return "";
  if (field.kind === "yesno") return parseYesNo(answer);
  if (field.kind === "choice") {
    const choices = field.choices ?? [];
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length && /^\d+$/.test(answer)) return choices[n - 1].value;
    return choices.find(c => c.value.toLowerCase() === answer.toLowerCase())?.value;
  }
  return answer;
}

/** Auswahl nach der Übersicht: Nummern oder Namen, getrennt durch Komma oder Leerzeichen */
export function parseSelection(answer: string): StepId[] | null {
  const parts = answer.split(/[\s,]+/).filter(Boolean);
  const ids: StepId[] = [];
  for (const p of parts) {
    const n = Number(p);
    const step = /^\d+$/.test(p) ? STEP_ORDER[n - 1] : STEP_ORDER.find(s => s.id === p.toLowerCase());
    if (!step) return null;
    if (!ids.includes(step.id)) ids.push(step.id);
  }
  return ids;
}

/** Führt tybo setup aus; gibt den Exit-Code zurück */
export async function runSetup(args: SetupArgs, options: SetupUiOptions): Promise<number> {
  const run = new SetupRun(options);
  const off = options.onInterrupt?.(() => {
    run.interrupt.trigger();
    options.prompter.cancel?.();
  });
  try {
    await run.learnSecrets();
    return await runMode(run, args);
  } catch (e) {
    if (!(e instanceof SetupAbort)) throw e;
    run.out.line();
    run.out.line(e instanceof AbortAfterRun ? abortRunMessage(e) : abortMessage(run, e instanceof AbortAfterWrite));
    run.out.line(`Weiter später mit: ${BRAND.cli} setup`);
    return EXIT_ABORTED;
  } finally {
    off?.();
    options.prompter.close?.();
  }
}

function abortRunMessage(e: AbortAfterRun): string {
  if (e.ended) return "Abgebrochen. Was der Ablauf schon erledigt hat, steht oben; schon gespeicherte Schritte bleiben.";
  return "Abgebrochen, ohne dass der Ablauf aufgehört hat. Was er schon erledigt hat, bleibt; schon gespeicherte Schritte bleiben.";
}

function abortMessage(run: SetupRun, afterWrite: boolean): string {
  const progress = run.progress;
  if (progress && !progress.failed && afterWrite) {
    return "Abgebrochen. Der laufende Schritt wurde vorher noch fertig gespeichert; die übrigen Schritte fehlen.";
  }
  if (progress && progress.changed.length) {
    const what = progress.changed.map(c => run.relative(c)).join(", ");
    return `Abgebrochen. Im laufenden Schritt wurde nur ein Teil gespeichert (${what}), der Rest fehlt; schon gespeicherte Schritte bleiben.`;
  }
  if (progress?.failed) {
    return "Abgebrochen. Das Speichern im laufenden Schritt ist fehlgeschlagen, geschrieben wurde nichts; schon gespeicherte Schritte bleiben.";
  }
  return "Abgebrochen. Im laufenden Schritt wurde nichts geschrieben; schon gespeicherte Schritte bleiben.";
}

async function runMode(run: SetupRun, args: SetupArgs): Promise<number> {
  const { out } = run;
  if (args.mode === "list") {
    out.line(`${BRAND.name} einrichten: Übersicht (${run.ctx.root})`);
    out.line();
    run.printOverview(await run.statuses());
    out.line();
    out.line(`Einrichten mit: ${BRAND.cli} setup, einzeln mit: ${BRAND.cli} setup <Schritt>`);
    return 0;
  }

  if (args.mode === "step") {
    const step = run.findStep(args.step)!;
    if (step.id === "pruefung") {
      const failed = await run.finalCheck();
      out.line();
      if (failed.length) {
        out.line(`Gesamtprüfung fehlgeschlagen: ${failed.map(id => getStep(id)!.title).join(", ")}. Beheben mit: ${failed.map(id => `${BRAND.cli} setup ${id}`).join(", ")}`);
      }
      return 0;
    }
    const outcome = await run.runStep(step, "", true);
    run.outcomes.set(step.id, outcome);
    out.line();
    out.line(`${step.title}: ${outcome}. Übersicht: ${BRAND.cli} setup --liste`);
    return 0;
  }

  out.line(`${BRAND.name} einrichten (${run.ctx.root})`);
  out.line("Abbrechen jederzeit mit Strg+C; schon gespeicherte Schritte bleiben.");
  out.line();
  const statuses = await run.statuses();
  run.printOverview(statuses);
  out.line();

  const open = STEP_ORDER.filter(s => statuses.get(s.id)!.state !== "erledigt").map(s => s.id);
  let chosen: StepId[] = [];
  for (;;) {
    out.line(open.length ? "Enter: die offenen Schritte der Reihe nach." : "Alles erledigt. Enter: nur die Gesamtprüfung.");
    const answer = await run.ask("Erledigte trotzdem bearbeiten? Ihre Nummern eingeben (z. B. 2,5), sonst Enter: ");
    const parsed = parseSelection(answer);
    if (parsed) {
      chosen = parsed;
      break;
    }
    out.line("Unbekannte Auswahl. Nummern aus der Liste oder Namen wie telegram eingeben.");
  }

  const todo = STEP_ORDER.filter(s => open.includes(s.id) || chosen.includes(s.id));
  const skipped: StepId[] = [];
  for (const [i, step] of todo.entries()) {
    const outcome = await run.runStep(step, `Schritt ${i + 1} von ${todo.length}: `, chosen.includes(step.id));
    run.outcomes.set(step.id, outcome);
    if (outcome === "übersprungen") skipped.push(step.id);
  }
  const checkFailed = await run.finalCheck();
  await run.printEnd(skipped, checkFailed);
  return 0;
}
