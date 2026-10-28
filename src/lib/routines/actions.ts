/**
 * Routinen bedienen (Issue #288, Entscheidung 0025): Pausieren, Fortsetzen
 * und „Jetzt testen" für launchd-Routinen.
 *
 * - pause: `launchctl disable gui/<uid>/<label>`, dann `launchctl bootout
 *   gui/<uid>/<label>` (disable übersteht einen Neustart des Rechners)
 * - resume: `launchctl enable gui/<uid>/<label>`, dann `launchctl bootstrap
 *   gui/<uid> <plist>` mit der Datei, in der das Label tatsächlich steht
 * - run: `launchctl kickstart gui/<uid>/<label>` ohne -k: ein laufender Lauf
 *   wird nie abgebrochen, er meldet „läuft gerade"
 *
 * Vor jeder Aktion liest der Katalog den Zustand frisch, danach noch einmal:
 * gemeldet wird der gelesene Zustand, nie der erwartete, auch bei run (ein
 * kurzer Lauf, der beim Nachlesen schon fertig ist, zählt über den Verlauf).
 * Teilerfolge (deaktiviert, aber noch geladen; aktiviert, aber nicht geladen)
 * stehen als solche im Ergebnis; ein weiteres Pausieren einer deaktivierten,
 * aber noch geladenen Routine holt das Entladen nach.
 *
 * Gesperrt sind hier selbst, nicht erst in der Oberfläche: der Dienst des
 * Bots (ai.tybo.telegram-relay), Dauerdienste und alles, was nicht im Katalog
 * steht (ai.tybo.* und config/routines.json). Unter PM2 und ohne launchd ruft
 * keine Aktion etwas auf.
 *
 * Alle Befehle laufen über RoutinesDeps.run (Muster LaunchdDeps in
 * src/setup/services/launchd.ts); Tests reichen eine Attrappe herein und rufen
 * nie echtes launchctl auf. Ins Log kommen nur Routinen-ID, Aktion und Kanal.
 */

import { BOT_SERVICE, launchdLabel } from "../service-names";
import { listRoutines, type RoutinesDeps } from "./catalog";
import { nextRunText, type FormatOptions } from "./format";
import { routineLogLine } from "./log";
import type { Routine, RoutineState } from "./types";

export const ROUTINE_ACTIONS = ["pause", "resume", "run"] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];

export function isRoutineAction(value: unknown): value is RoutineAction {
  return typeof value === "string" && (ROUTINE_ACTIONS as readonly string[]).includes(value);
}

/**
 * done: gelesener Zustand passt zur Aktion. partial: nur ein Teil hat
 * geklappt. failed: nichts hat sich geändert oder der Zustand danach ist
 * unbekannt. already: schon im Zielzustand, nichts aufgerufen (aus der WebUI
 * auch: derselbe Auftrag kam schon einmal an). busy: läuft gerade (run).
 * wrong-state: Zustand passt nicht zur
 * Aktion (etwa Testen einer pausierten Routine), nichts aufgerufen.
 * blocked: Bot-Dienst oder Dauerdienst. unknown: nicht im Katalog.
 * unavailable: kein launchd (PM2 oder gar nichts).
 */
export type RoutineActionStatus = "done" | "partial" | "failed" | "already" | "busy" | "wrong-state" | "blocked" | "unknown" | "unavailable";

export interface RoutineActionResult {
  status: RoutineActionStatus;
  action: RoutineAction;
  id: string;
  /** Meldung für Telegram, Browser und Terminal */
  text: string;
  /** Zustand nach der Aktion (frisch gelesen); null, wenn nicht lesbar oder nicht zutreffend */
  state: RoutineState | null;
  /** Die Routine nach der Aktion, wie der Katalog sie liest */
  routine?: Routine;
}

export type ActionChannel = "telegram" | "web" | "terminal";

export interface RoutineActionOptions {
  /** Kanal, aus dem die Aktion kommt; nur fürs Log */
  channel?: ActionChannel;
  log?: (line: string) => void;
  /** Zeit und Zeitzone für „Nächster Lauf" */
  format?: FormatOptions;
}

/** Label des Bot-Diensts: auf keinem Weg pausierbar oder startbar */
export const BOT_LABEL = launchdLabel(BOT_SERVICE);

export const ACTION_TEXT = {
  unavailable: "Pausieren, Fortsetzen und Testen sind auf diesem System nicht verfügbar.",
  unknown: (id: string) => `Keine Routine ${id}. /routinen zeigt alle.`,
  blockedBot: (name: string) => `${name} ist der Dienst von tybo selbst und lässt sich hier nicht pausieren, fortsetzen oder testen.`,
  blockedDaemon: (name: string) => `${name} ist ein Dauerdienst und lässt sich hier nicht pausieren, fortsetzen oder testen.`,
  stateUnknown: (name: string) => `Der Zustand von ${name} ist unbekannt, nichts geändert.`,
  paused: (name: string) => `⏸️ ${name} ist pausiert. Nächster Lauf: keiner, bis du fortsetzt.`,
  alreadyPaused: (name: string) => `${name} ist schon pausiert.`,
  pauseFailed: (name: string) => `Pausieren hat nicht geklappt: ${name} ist weiter aktiv.`,
  pauseFailedNotLoaded: (name: string) =>
    `Pausieren hat nicht geklappt: ${name} ist nicht deaktiviert und auch nicht geladen. Nächster Lauf: keiner, bis sie wieder geladen wird (spätestens beim nächsten Neustart).`,
  pauseCompleted: (name: string) => `⏸️ ${name} war schon deaktiviert, aber noch geladen; jetzt auch entladen. Nächster Lauf: keiner, bis du fortsetzt.`,
  pausePartial: (name: string) =>
    `Pausieren hat nur zum Teil geklappt: ${name} ist deaktiviert, aber noch geladen und kann bis zum nächsten Neustart weiterlaufen.`,
  pauseUnknownAfter: (name: string) => `Pausieren: der Zustand von ${name} danach ist unbekannt.`,
  resumed: (name: string, next: string | null) => `▶️ ${name} ist wieder aktiv. Nächster Lauf: ${next ?? "unbekannt"}.`,
  alreadyActive: (name: string) => `${name} ist schon aktiv.`,
  resumeFailed: (name: string) => `Fortsetzen hat nicht geklappt: ${name} ist weiter pausiert.`,
  resumeFailedStillLoaded: (name: string, running: boolean) =>
    `Fortsetzen hat nicht geklappt: ${name} ist weiter deaktiviert, aber noch geladen${running ? " und läuft gerade" : ""}; sie kann bis zum nächsten Neustart weiterlaufen.`,
  resumePartial: (name: string) => `Fortsetzen hat nur zum Teil geklappt: ${name} ist wieder aktiviert, aber nicht geladen. Nächster Lauf: keiner.`,
  resumeUnknownAfter: (name: string) => `Fortsetzen: der Zustand von ${name} danach ist unbekannt.`,
  started: (name: string) => `▶️ ${name} gestartet. Nach dem Lauf steht er oben im Verlauf (/routinen ${name}).`,
  startedFinished: (name: string, exitCode: number) =>
    `▶️ ${name} gestartet und schon fertig (Exit-Code ${exitCode}). Der Lauf steht oben im Verlauf (/routinen ${name}).`,
  startedNotSeen: (name: string) =>
    `▶️ Start von ${name} ausgelöst. Beim Nachlesen lief sie schon nicht mehr; ob der Lauf geklappt hat, zeigt der Verlauf (/routinen ${name}).`,
  startedUnknownAfter: (name: string) => `Start von ${name} ausgelöst, aber der Zustand danach ist unbekannt. Nicht noch einmal starten, erst /routinen ${name} prüfen.`,
  runFailedButRunning: (name: string) => `Starten meldete einen Fehler, ${name} läuft aber gerade. Nichts neu gestartet.`,
  runFailedButFinished: (name: string, exitCode: number) =>
    `Starten meldete einen Fehler, ${name} ist aber eben gelaufen (Exit-Code ${exitCode}). Der Lauf steht oben im Verlauf (/routinen ${name}).`,
  runFailedUnknownAfter: (name: string) => `Starten meldete einen Fehler, der Zustand von ${name} danach ist unbekannt.`,
  running: (name: string) => `${name} läuft gerade. Nichts neu gestartet.`,
  runFailed: (name: string) => `Starten hat nicht geklappt: ${name} läuft nicht.`,
  runPaused: (name: string) => `${name} ist pausiert. Erst fortsetzen, dann testen.`,
  runNotLoaded: (name: string) => `${name} ist nicht geladen und lässt sich so nicht testen. Fortsetzen lädt sie wieder.`,
} as const;

/**
 * Welche Aktionen das Menü einer Routine anbietet: aktiv „Jetzt testen" und
 * „Pausieren", pausiert oder nicht geladen „Fortsetzen", sonst keine (Bot,
 * Dauerdienst, PM2, unbekannter Zustand).
 */
export function menuActions(r: Routine): RoutineAction[] {
  if (blockReason(r) || r.source !== "launchd") return [];
  if (r.state === "active") return ["run", "pause"];
  // Deaktiviert, aber noch geladen (Pausieren nur zum Teil geklappt): Pausieren holt das Entladen nach
  if (r.state === "paused" && r.facts?.disabled === true && r.facts.loaded === true) return ["resume", "pause"];
  if (r.state === "paused" || r.state === "not-loaded") return ["resume"];
  return [];
}

/** Gesperrt für jede Aktion? Text der Sperre oder null */
export function blockReason(r: Pick<Routine, "id" | "name" | "kind">): string | null {
  if (r.id === BOT_LABEL) return ACTION_TEXT.blockedBot(r.name);
  if (r.kind === "daemon") return ACTION_TEXT.blockedDaemon(r.name);
  return null;
}

/** Name einer Routine-ID wie im Katalog (ohne ai.tybo.) */
function nameOf(id: string): string {
  return id.startsWith("ai.tybo.") ? id.slice("ai.tybo.".length) : id;
}

async function readRoutine(deps: RoutinesDeps, id: string): Promise<Routine | null> {
  const list = await listRoutines(deps);
  if (list.source !== "launchd") return null;
  return list.routines.find(r => r.id === id) ?? null;
}

/** Der Zustand hängt nur an den Rohangaben; fehlen sie, ist er unbekannt */
function facts(r: Routine) {
  return r.facts ?? { loaded: null, running: null, disabled: null };
}

/**
 * Führt eine Aktion an einer Routine aus. Wirft nicht bei gescheiterten
 * Befehlen (die stehen im Ergebnis), nur wenn deps selbst werfen.
 */
export async function performRoutineAction(
  deps: RoutinesDeps,
  id: string,
  action: RoutineAction,
  options: RoutineActionOptions = {}
): Promise<RoutineActionResult> {
  const log = options.log ?? (line => console.log(line));
  const channel = options.channel ?? "telegram";
  const result = (status: RoutineActionStatus, text: string, routine?: Routine | null): RoutineActionResult => {
    log(routineLogLine(id, action, channel));
    return { status, action, id, text, state: routine ? routine.state : null, ...(routine ? { routine } : {}) };
  };
  if (!isRoutineAction(action)) throw new Error("unbekannte Aktion");

  // Ohne launchd ruft keine Aktion etwas auf, auch kein Lesen
  if (deps.platform !== "darwin") return result("unavailable", ACTION_TEXT.unavailable);
  // Der Bot-Dienst ist schon vor dem Lesen gesperrt
  if (id === BOT_LABEL) return result("blocked", ACTION_TEXT.blockedBot(nameOf(id)));

  const before = await readRoutine(deps, id);
  if (!before) return result("unknown", ACTION_TEXT.unknown(nameOf(id)));
  const name = before.name;
  const blocked = blockReason(before);
  if (blocked) return result("blocked", blocked, before);
  if (before.source !== "launchd") return result("unavailable", ACTION_TEXT.unavailable, before);

  const target = `gui/${deps.uid}/${id}`;
  const f = facts(before);
  const step = async (cmd: string[]): Promise<boolean> => (await deps.run(cmd).catch(() => ({ ok: false }))).ok;
  const reread = () => readRoutine(deps, id).catch(() => null);

  if (action === "pause") {
    if (f.disabled === true && f.loaded === false) return result("already", ACTION_TEXT.alreadyPaused(name), before);
    if (f.disabled === null || f.loaded === null) return result("wrong-state", ACTION_TEXT.stateUnknown(name), before);
    // Schon deaktiviert, aber noch geladen (Teilerfolg eines früheren Pausierens): nur noch entladen
    const completing = f.disabled === true;
    if (completing || (await step(["launchctl", "disable", target]))) {
      if (f.loaded) await step(["launchctl", "bootout", target]);
    }
    const after = await reread();
    const a = after ? facts(after) : null;
    if (!after || !a || a.disabled === null || a.loaded === null) return result("failed", ACTION_TEXT.pauseUnknownAfter(name), after);
    if (a.disabled && !a.loaded) return result("done", completing ? ACTION_TEXT.pauseCompleted(name) : ACTION_TEXT.paused(name), after);
    if (a.disabled) return result("partial", ACTION_TEXT.pausePartial(name), after);
    // Nicht deaktiviert: aktiv nur, wenn auch geladen
    return result("failed", a.loaded ? ACTION_TEXT.pauseFailed(name) : ACTION_TEXT.pauseFailedNotLoaded(name), after);
  }

  if (action === "resume") {
    if (f.disabled === false && f.loaded === true) return result("already", ACTION_TEXT.alreadyActive(name), before);
    if (f.disabled === null || f.loaded === null) return result("wrong-state", ACTION_TEXT.stateUnknown(name), before);
    if (!before.plistPath) return result("wrong-state", ACTION_TEXT.stateUnknown(name), before);
    const enabled = f.disabled ? await step(["launchctl", "enable", target]) : true;
    if (enabled && !f.loaded) await step(["launchctl", "bootstrap", `gui/${deps.uid}`, before.plistPath]);
    const after = await reread();
    const a = after ? facts(after) : null;
    if (!after || !a || a.disabled === null || a.loaded === null) return result("failed", ACTION_TEXT.resumeUnknownAfter(name), after);
    if (!a.disabled && a.loaded) return result("done", ACTION_TEXT.resumed(name, nextRunText(after, options.format)), after);
    if (!a.disabled) return result("partial", ACTION_TEXT.resumePartial(name), after);
    // Weiter deaktiviert: noch geladen (Teil-Pause) ist nicht „pausiert"
    return result("failed", a.loaded ? ACTION_TEXT.resumeFailedStillLoaded(name, a.running === true) : ACTION_TEXT.resumeFailed(name), after);
  }

  // run
  if (f.disabled === true) return result("wrong-state", ACTION_TEXT.runPaused(name), before);
  if (f.loaded === false) return result("wrong-state", ACTION_TEXT.runNotLoaded(name), before);
  if (f.disabled === null || f.loaded === null || f.running === null) return result("wrong-state", ACTION_TEXT.stateUnknown(name), before);
  if (f.running) return result("busy", ACTION_TEXT.running(name), before);
  const kicked = await step(["launchctl", "kickstart", target]);
  const after = await reread();
  const a = after ? facts(after) : null;
  // Ein kurzer Lauf kann beim Nachlesen schon fertig sein: dann steht er neu im Verlauf
  const finished = after ? newerRun(before, after) : null;
  const running = a?.loaded === true && a.running === true;
  if (kicked) {
    if (running) return result("done", ACTION_TEXT.started(name), after);
    if (finished) return result("done", ACTION_TEXT.startedFinished(name, finished.exitCode), after);
    if (!a || a.loaded === null || a.running === null) return result("partial", ACTION_TEXT.startedUnknownAfter(name), after);
    return result("done", ACTION_TEXT.startedNotSeen(name), after);
  }
  if (running) return result("busy", ACTION_TEXT.runFailedButRunning(name), after);
  if (finished) return result("partial", ACTION_TEXT.runFailedButFinished(name, finished.exitCode), after);
  if (!a || a.loaded === null || a.running === null) return result("failed", ACTION_TEXT.runFailedUnknownAfter(name), after);
  return result("failed", ACTION_TEXT.runFailed(name), after);
}

/** Lauf, der nach before neu im Verlauf steht (Wrapper, Issue #285); sonst null */
function newerRun(before: Routine, after: Routine): Routine["lastRun"] {
  const run = after.lastRun;
  if (!run) return null;
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return null;
  const old = before.lastRun ? Date.parse(before.lastRun.startedAt) : NaN;
  return Number.isFinite(old) && start <= old ? null : run;
}
