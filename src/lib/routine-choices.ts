/**
 * Routinen bedienen über das Rückfragen-Register (Issue #288, Entscheidungen
 * 0017 und 0025): Art "routine", ref ist die Routinen-ID (launchd-Label).
 *
 * Zwei Stufen, die Stufe steht dauerhaft in Choice.action:
 * - "menu" (/routinen <name> und die Fehlermeldung aus Issue #287): Knöpfe
 *   „▶️ Jetzt testen" (run) und „⏸️ Pausieren" (pause) bzw. „▶️ Fortsetzen"
 *   (resume), je nach Zustand (menuActions in routines/actions.ts).
 * - "pause" bzw. "resume": die Rückfrage „wirklich pausieren?" mit "yes" und
 *   "no". Erst "yes" handelt. „Jetzt testen" fragt nicht nach.
 *
 * Genau einmal: Der Handler läuft nur im Gewinnerprozess von decideChoice.
 * Aktionen laufen je Routine nacheinander (queue), und performRoutineAction
 * liest den Zustand unmittelbar vor der Aktion: ein alter Knopf einer
 * inzwischen pausierten Routine meldet „ist schon pausiert", ohne launchctl.
 *
 * Der Reiter „Routinen" im Browser (fromSettings) geht über dieselbe
 * Entscheidung. Jeder Auftrag trägt eine Kennung, die das Register festhält
 * (claimChoiceRequest): kommt derselbe POST noch einmal an, nach Laufende,
 * nach einer Gegenaktion oder nach einem Neustart, handelt nichts mehr. Steht für die Routine eine offene Rückfrage derselben Aktion,
 * entscheidet er sie mit "yes" im Register (via "web"); Telegram zeigt sie
 * dann als erledigt. Sonst handelt er direkt, in derselben Reihe je Routine.
 * Nach jeder Änderung des Zustands laufen offene Fragen der Routine ab, die
 * nicht mehr passen (Menüs und Rückfragen); neu gezeigt wird nichts.
 *
 * Ein neues Menü ersetzt ältere offene Menüs derselben Routine im selben
 * Gespräch unter der Sperre des Registers (createChoice mit replace): zwei
 * gleichzeitige Aufrufe, auch Wrapper und Bot, lassen nur eins offen.
 *
 * Ergebnis als Meldung im Gespräch der Frage (notify), in Telegram und im
 * Browser. Ins Log kommen nur Routinen-ID, Aktion und Kanal, auch auf
 * Fehlerwegen: jede Zeile ist `[routinen] <id> <aktion> (<kanal>)`, Aktion
 * pause, resume, run oder menu (Menü zeigen), Kanal telegram, web oder terminal.
 */

import {
  claimChoiceRequest,
  createChoice,
  decideChoice,
  expireChoice,
  listChoices,
  type Choice,
  type ChoiceChannel,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type ClaimRequestOutcome,
  type CreateChoiceInput,
  type CreateChoiceOptions,
  type DecideOutcome,
  type ExpireOutcome,
} from "./choices";
import { ACTION_TEXT, blockReason, menuActions, performRoutineAction, type ActionChannel, type RoutineAction, type RoutineActionResult } from "./routines/actions";
import { listRoutines, type RoutinesDeps } from "./routines/catalog";
import { routineLogLine, type RoutineLogAction } from "./routines/log";
import type { AlertMeta, AlertSender } from "./routines/alerts";
import { STATE_TEXT, type FormatOptions } from "./routines/format";
import type { Routine } from "./routines/types";

/** source der Fragen und Meldungen, wie CHOICE_SOURCES.routine und ALERT_SOURCE */
export const ROUTINE_SOURCE = "routine";

export const ROUTINE_STEP_MENU = "menu";
export const ROUTINE_YES = "yes";
export const ROUTINE_NO = "no";

export const ROUTINE_MENU_LABELS: Record<RoutineAction, string> = {
  run: "▶️ Jetzt testen",
  pause: "⏸️ Pausieren",
  resume: "▶️ Fortsetzen",
};

/** Rückfrage vor Pausieren und Fortsetzen */
export const ROUTINE_CONFIRM_OPTIONS: Record<"pause" | "resume", ChoiceOption[]> = {
  pause: [
    { key: ROUTINE_YES, label: "Ja, pausieren" },
    { key: ROUTINE_NO, label: "Abbrechen" },
  ],
  resume: [
    { key: ROUTINE_YES, label: "Ja, fortsetzen" },
    { key: ROUTINE_NO, label: "Abbrechen" },
  ],
};

/** Rückfragen gelten einen Tag; Menüs so lange wie das Register sie aufbewahrt */
export const ROUTINE_CONFIRM_TTL_MS = 24 * 3_600_000;

export const ROUTINE_CHOICE_TEXT = {
  menu: (name: string, state: string) => `${name} (${state}): Was soll passieren?`,
  confirmPause: (name: string) => `${name} wirklich pausieren? Sie läuft dann nicht mehr, bis du fortsetzt.`,
  confirmResume: (name: string) => `${name} wirklich fortsetzen? Sie läuft dann wieder nach ihrem Zeitplan.`,
  cancelled: (name: string) => `Abgebrochen, ${name} bleibt, wie sie ist.`,
  failed: (name: string) => `Die Aktion für ${name} ist fehlgeschlagen. Details im Log.`,
  noConfirm: (name: string) => `Die Rückfrage zu ${name} ließ sich nicht zustellen, nichts geändert.`,
  notNow: (name: string, state: string) => `${name} ist gerade ${state}, nichts geändert.`,
  duplicate: (name: string) => `Dieser Auftrag für ${name} ist schon angekommen, nichts noch einmal ausgeführt.`,
  requestFailed: (name: string) => `Der Auftrag für ${name} ließ sich nicht festhalten, nichts geändert.`,
} as const;

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

/** Name wie im Katalog (ohne ai.tybo.) */
function nameOf(id: string): string {
  return id.startsWith("ai.tybo.") ? id.slice("ai.tybo.".length) : id;
}

/** Aktion im Log: eine der drei Aktionen oder menu (Menü bzw. Rückfrage zeigen) */
type LogAction = RoutineLogAction;

/** Kanal eines Gesprächs fürs Log: Web-Gespräche und der Direktchat ohne Telegram sind web */
export function routineChannel(conversation: ChoiceConversation | null): ActionChannel {
  if (!conversation || conversation.type === "web" || conversation.chatId === "web") return "web";
  return "telegram";
}

/** Aktion einer Frage fürs Log (Menü oder Rückfrage) */
function choiceLogAction(choice: Choice): LogAction {
  return choice.action === "pause" || choice.action === "resume" ? choice.action : ROUTINE_STEP_MENU;
}

/** Gespräch eines Befehls aus Chat und Topic; reine Web-Gespräche heißen web:<uuid> */
const TELEGRAM_CHAT = /^(-?\d{1,20}|web)$/;
const WEB_CHAT = /^web:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function routineConversation(chatId: string, topicId?: number): ChoiceConversation | null {
  const web = WEB_CHAT.exec(chatId);
  if (web) return { type: "web", conversationId: web[1] };
  if (!TELEGRAM_CHAT.test(chatId)) return null;
  return Number.isInteger(topicId) ? { type: "telegram", chatId, topicId } : { type: "telegram", chatId };
}

export interface RoutineChoicesDeps {
  /** Lesen und Handeln (launchd über RoutinesDeps.run); Tests reichen die Attrappe herein */
  routines: RoutinesDeps;
  /** Frage zeigen: in Telegram mit Knöpfen bzw. ohne Telegram für die WebUI festgehalten (sendChoice) */
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  /** Frage in ein reines Web-Gespräch legen (wie postWeb in review-choices.ts); true: angenommen */
  postWeb?(conversationId: string, post: { text: string; kind: "notice"; source: string; choiceId?: string }): Promise<boolean>;
  /** Ergebnis als Meldung im Gespräch der Frage (Telegram und Browser); darf werfen, geloggt wird hier */
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
  /** Standard aus dem Register */
  createChoice?(input: CreateChoiceInput, options?: CreateChoiceOptions): Promise<Choice>;
  listChoices?(): Promise<Choice[]>;
  decideChoice?(id: string, key: string, via: ChoiceChannel): Promise<DecideOutcome>;
  expireChoice?(id: string): Promise<ExpireOutcome>;
  claimRequest?(key: string, input: { kind: "routine"; ref: string; action: string }): Promise<ClaimRequestOutcome>;
  /** Standard performRoutineAction */
  perform?: typeof performRoutineAction;
  /** Zeit und Zeitzone für „Nächster Lauf" */
  format?(): FormatOptions;
  log?: Log;
}

export type OfferOutcome =
  | { status: "sent"; choice: Choice }
  /** Keine Knöpfe für diese Routine (Bot, Dauerdienst, PM2, unbekannter Zustand, nicht im Katalog) */
  | { status: "none" }
  /** Nirgends gezeigt (oder vor dem Versand abgebrochen): nichts offen, nichts unterwegs */
  | { status: "failed" }
  /**
   * Versand war unterwegs, als das Zeitlimit ablief, und kam nicht zurück:
   * das Menü ist abgelaufen, ob die Nachricht ankam, ist unbekannt. Kein
   * zweiter Versand ohne Knöpfe, sonst stünde die Meldung womöglich doppelt da.
   */
  | { status: "unknown" };

/** Abbruch von offerMenu (Zeitlimit des Wrappers) */
export interface OfferControl {
  /** Nach dem Abbruch legt offerMenu nichts mehr an und sendet nichts mehr; schon Angelegtes läuft ab */
  signal?: AbortSignal;
  /** Unmittelbar vor dem Versand; ab hier ist die Nachricht unterwegs und lässt sich nicht mehr zurückholen */
  onDeliver?(choice: Choice): void;
}

export type SettingsOutcome =
  | { status: "acted"; result: RoutineActionResult }
  /** Pausieren oder Fortsetzen ohne confirm: nichts geändert */
  | { status: "confirm-required" };

export interface RoutineChoices {
  /**
   * Menü zu einer Routine anlegen und zeigen. text ersetzt den Standardtext
   * (Fehlermeldung aus Issue #287). Ältere offene Menüs derselben Routine im
   * selben Gespräch laufen vorher ab: ein zweiter Versand ergibt kein
   * zusätzliches offenes Menü.
   */
  offerMenu(conversation: ChoiceConversation, id: string, text?: string, control?: OfferControl): Promise<OfferOutcome>;
  /** Handler der Art "routine" (onChoiceDecided) */
  handler: ChoiceHandler;
  /**
   * Reiter „Routinen": pause und resume nur mit confirm true. request ist die
   * Kennung des Auftrags (isChoiceRequestKey); dieselbe Kennung handelt nur einmal.
   */
  fromSettings(id: string, action: RoutineAction, confirm: boolean, request: string): Promise<SettingsOutcome>;
  /** Für Tests: bis alle angestoßenen Abläufe fertig sind */
  settled(): Promise<void>;
}

export function createRoutineChoices(deps: RoutineChoicesDeps): RoutineChoices {
  const log = deps.log ?? defaultLog;
  const create = deps.createChoice ?? createChoice;
  const list = deps.listChoices ?? listChoices;
  const decide = deps.decideChoice ?? decideChoice;
  const expire = deps.expireChoice ?? expireChoice;
  const claim = deps.claimRequest ?? claimChoiceRequest;
  const perform = deps.perform ?? performRoutineAction;

  // Ergebnis je entschiedener Rückfrage, für fromSettings (der Handler läuft in decideChoice)
  const results = new Map<string, RoutineActionResult>();

  // Je Routine nacheinander: zwei Klicks (Telegram und Browser, doppelter POST) handeln nie gleichzeitig
  const tails = new Map<string, Promise<unknown>>();
  function queue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (tails.get(id) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => {});
    tails.set(id, tail);
    void tail.then(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
    return next;
  }

  async function readRoutine(id: string): Promise<Routine | null> {
    const l = await listRoutines(deps.routines);
    return l.source === "launchd" ? (l.routines.find(r => r.id === id) ?? null) : null;
  }

  async function openFor(id: string): Promise<Choice[]> {
    return (await list()).filter(c => c.kind === "routine" && c.ref === id && c.state === "open");
  }

  /** Offene Fragen einer Routine ablaufen lassen (filter: welche); action und channel nur fürs Log */
  async function expireOpen(id: string, action: LogAction, channel: ActionChannel, filter: (c: Choice) => boolean): Promise<void> {
    let open: Choice[];
    try {
      open = await openFor(id);
    } catch {
      log(routineLogLine(id, action, channel));
      return;
    }
    for (const c of open.filter(filter)) {
      await expire(c.id).catch(() => log(routineLogLine(id, action, channel)));
    }
  }

  /** Meldung im Gespräch; scheitert sie, steht nur Routine, Aktion und Kanal im Log */
  async function notify(id: string, action: LogAction, conversation: ChoiceConversation, text: string): Promise<void> {
    try {
      await deps.notify(conversation, text);
    } catch {
      log(routineLogLine(id, action, routineChannel(conversation)));
    }
  }

  /** Frage zeigen: Web-Gespräch selbst plus Kopie im Direktchat, sonst Telegram bzw. festgehalten */
  async function deliver(choice: Choice): Promise<boolean> {
    const id = choice.ref ?? "";
    let shown = false;
    if (choice.conversation.type === "web" && deps.postWeb) {
      try {
        shown = await deps.postWeb(choice.conversation.conversationId, { text: choice.text, kind: "notice", source: ROUTINE_SOURCE, choiceId: choice.id });
      } catch {
        log(routineLogLine(id, choiceLogAction(choice), "web"));
      }
    }
    let sent = false;
    try {
      sent = (await deps.sendChoice(choice)).sent;
    } catch {
      log(routineLogLine(id, choiceLogAction(choice), routineChannel(choice.conversation)));
    }
    if (shown || sent) return true;
    await expire(choice.id).catch(() => {});
    return false;
  }

  async function offerMenu(conversation: ChoiceConversation, id: string, text?: string, control: OfferControl = {}): Promise<OfferOutcome> {
    const aborted = () => control.signal?.aborted === true;
    const routine = await readRoutine(id);
    // Abgebrochen, während der Katalog gelesen wurde: nichts anlegen, nichts senden
    if (aborted()) return { status: "failed" };
    const actions = routine ? menuActions(routine) : [];
    if (!routine || actions.length === 0) return { status: "none" };
    // Ablauf der älteren Menüs und Anlage des neuen unter einer Sperre des Registers
    const same = (c: Choice) =>
      c.kind === "routine" && c.ref === id && c.action === ROUTINE_STEP_MENU && JSON.stringify(c.conversation) === JSON.stringify(conversation);
    const choice = await create(
      {
        kind: "routine",
        conversation,
        text: text ?? ROUTINE_CHOICE_TEXT.menu(routine.name, STATE_TEXT[routine.state]),
        options: actions.map(a => ({ key: a, label: ROUTINE_MENU_LABELS[a] })),
        ref: id,
        action: ROUTINE_STEP_MENU,
      },
      { replace: same }
    );
    // Abgebrochen, während das Menü angelegt wurde: wieder ablaufen lassen, nicht senden
    if (aborted()) {
      await expire(choice.id).catch(() => log(routineLogLine(id, ROUTINE_STEP_MENU, routineChannel(conversation))));
      return { status: "failed" };
    }
    // Ohne await bis zum Versand: zwischen Prüfung und Versand kann kein Abbruch dazwischenkommen
    control.onDeliver?.(choice);
    return (await deliver(choice)) ? { status: "sent", choice } : { status: "failed" };
  }

  /** Nach einer Änderung: offene Fragen der Routine, deren Knöpfe nicht mehr passen, ablaufen lassen */
  async function afterChange(id: string, result: RoutineActionResult, via: ChoiceChannel, except?: string): Promise<void> {
    if (result.action === "run") return;
    if (result.status !== "done" && result.status !== "partial") return;
    await expireOpen(id, result.action, via, c => c.id !== except);
  }

  /** Aktion ausführen und Ergebnis zurückgeben (in der Reihe der Routine) */
  function act(id: string, action: RoutineAction, via: ChoiceChannel, except?: string): Promise<RoutineActionResult> {
    return queue(id, async () => {
      const result = await perform(deps.routines, id, action, { channel: via, log, format: deps.format?.() });
      await afterChange(id, result, via, except);
      return result;
    });
  }

  /**
   * Rückfrage vor Pausieren oder Fortsetzen; vorher prüfen, ob sie überhaupt
   * noch passt. Handelt selbst nie: Pausieren und Fortsetzen gibt es nur nach "yes".
   */
  async function askConfirm(menu: Choice, id: string, action: "pause" | "resume", via: ChoiceChannel): Promise<void> {
    const say = (text: string) => notify(id, action, menu.conversation, text);
    const routine = await readRoutine(id);
    if (!routine) {
      await say(ACTION_TEXT.unknown(nameOf(id)));
      return;
    }
    const blocked = blockReason(routine);
    if (blocked) {
      await say(blocked);
      return;
    }
    const f = routine.facts;
    // Deaktiviert, aber noch geladen ist nicht „schon pausiert": die Rückfrage holt das Entladen nach
    if (action === "pause" && f?.disabled === true && f.loaded === false) {
      await say(ACTION_TEXT.alreadyPaused(routine.name));
      return;
    }
    if (action === "resume" && f?.disabled === false && f?.loaded === true) {
      await say(ACTION_TEXT.alreadyActive(routine.name));
      return;
    }
    if (!menuActions(routine).includes(action)) {
      await say(ROUTINE_CHOICE_TEXT.notNow(routine.name, STATE_TEXT[routine.state]));
      return;
    }
    // Ältere offene Rückfragen derselben Routine im selben Gespräch gelten nicht mehr
    await expireOpen(id, action, via, c => c.action !== ROUTINE_STEP_MENU && JSON.stringify(c.conversation) === JSON.stringify(menu.conversation));
    const confirm = await create({
      kind: "routine",
      conversation: menu.conversation,
      text: action === "pause" ? ROUTINE_CHOICE_TEXT.confirmPause(routine.name) : ROUTINE_CHOICE_TEXT.confirmResume(routine.name),
      options: ROUTINE_CONFIRM_OPTIONS[action],
      ref: id,
      action,
      expiresAt: Date.now() + ROUTINE_CONFIRM_TTL_MS,
    });
    if (!(await deliver(confirm))) await say(ROUTINE_CHOICE_TEXT.noConfirm(routine.name));
  }

  const handler: ChoiceHandler = async choice => {
    const id = choice.ref;
    const key = choice.result?.key;
    const via = choice.result?.via ?? "telegram";
    if (typeof id !== "string" || !id || !key) throw new Error("Routinen-Frage ohne Routine oder Ergebnis");
    const name = nameOf(id);
    // Unbekannte Auswahl bzw. Schritt: als menu geloggt, nie der rohe Wert
    const logAction: LogAction =
      choice.action === ROUTINE_STEP_MENU ? (key === "run" || key === "pause" || key === "resume" ? key : ROUTINE_STEP_MENU) : choiceLogAction(choice);
    log(routineLogLine(id, logAction, via));
    try {
      if (choice.action === ROUTINE_STEP_MENU) {
        if (key === "run") {
          const result = await act(id, "run", via);
          await notify(id, "run", choice.conversation, result.text);
          return;
        }
        if (key === "pause" || key === "resume") {
          await askConfirm(choice, id, key, via);
          return;
        }
        throw new Error("unbekannte Menü-Auswahl");
      }
      if (choice.action === "pause" || choice.action === "resume") {
        if (key === ROUTINE_NO) {
          await notify(id, choice.action, choice.conversation, ROUTINE_CHOICE_TEXT.cancelled(name));
          return;
        }
        if (key !== ROUTINE_YES) throw new Error("unbekannte Antwort");
        const result = await act(id, choice.action, via, choice.id);
        results.set(choice.id, result);
        await notify(id, choice.action, choice.conversation, result.text);
        return;
      }
      throw new Error("Routinen-Frage ohne gültigen Schritt");
    } catch (e) {
      await notify(id, logAction, choice.conversation, ROUTINE_CHOICE_TEXT.failed(name));
      throw e;
    }
  };

  /** Auftrag schon angekommen: nichts tun, nur den Zustand frisch lesen (nach dem laufenden Auftrag der Routine) */
  function duplicate(id: string, action: RoutineAction): Promise<RoutineActionResult> {
    return queue(id, async () => {
      const routine = await readRoutine(id).catch(() => null);
      const name = routine?.name ?? nameOf(id);
      return { status: "already", action, id, text: ROUTINE_CHOICE_TEXT.duplicate(name), state: routine?.state ?? null, ...(routine ? { routine } : {}) };
    });
  }

  async function fromSettings(id: string, action: RoutineAction, confirm: boolean, request: string): Promise<SettingsOutcome> {
    if (action !== "run" && !confirm) return { status: "confirm-required" };
    // Kennung des Auftrags festhalten, bevor etwas geschieht; scheitert das, handelt nichts
    let claimed: ClaimRequestOutcome;
    try {
      claimed = await claim(request, { kind: "routine", ref: id, action });
    } catch {
      log(routineLogLine(id, action, "web"));
      return { status: "acted", result: { status: "failed", action, id, text: ROUTINE_CHOICE_TEXT.requestFailed(nameOf(id)), state: null } };
    }
    if (claimed.status === "already") return { status: "acted", result: await duplicate(id, action) };
    if (action === "run") return { status: "acted", result: await act(id, "run", "web") };
    // Offene Rückfrage derselben Aktion: im Register entscheiden, damit sie überall erledigt ist
    let open: Choice[] = [];
    try {
      open = (await openFor(id)).filter(c => c.action === action);
    } catch {
      log(routineLogLine(id, action, "web"));
    }
    for (const c of open) {
      const outcome = await decide(c.id, ROUTINE_YES, "web");
      if (outcome.status !== "decided") continue;
      const result = results.get(c.id);
      results.delete(c.id);
      if (result) return { status: "acted", result };
      // Gewonnen, aber der Handler hat nicht gehandelt (Fehler): nie ein zweites Mal daneben
      return { status: "acted", result: { status: "failed", action, id, text: ROUTINE_CHOICE_TEXT.failed(nameOf(id)), state: null } };
    }
    // Keine offene Frage (oder schon anders entschieden): direkt, in der Reihe; der Zustand wird dabei neu geprüft
    return { status: "acted", result: await act(id, action, "web") };
  }

  async function settled(): Promise<void> {
    while (tails.size > 0) await Promise.all([...tails.values()]);
  }

  return { offerMenu, handler, fromSettings, settled };
}

/**
 * Meldeweg mit Knöpfen (Issue #288): Fehler- und Ausgeblieben-Meldungen
 * kommen als Menü ("menu") mit dem Meldungstext und den Knöpfen „Jetzt
 * testen" und „Pausieren" in den Direktchat. Gibt es für die Routine keine
 * Knöpfe (Dauerdienst, Bot, PM2) oder ließ sich das Menü nicht zeigen, geht
 * die Meldung wie bisher ohne Knöpfe über plain. Entwarnungen immer ohne.
 * Ein zweiter Versand derselben Routine lässt das ältere Menü ablaufen
 * (offerMenu), es bleibt also höchstens eins offen. Ist der Ausgang des
 * Menü-Versands unbekannt ("unknown"), geht nichts ohne Knöpfe hinterher:
 * die Meldung gilt als nicht zugestellt. channel nennt den Kanal fürs Log.
 */
export function menuAlertSender(
  plain: AlertSender,
  offer: (id: string, text: string) => Promise<OfferOutcome>,
  log: Log = defaultLog,
  channel: () => ActionChannel = () => "telegram"
): AlertSender {
  return async (text: string, meta?: AlertMeta) => {
    if (meta && (meta.kind === "failed" || meta.kind === "missed")) {
      try {
        const outcome = await offer(meta.id, text);
        if (outcome.status === "sent") return { sent: true, recorded: true };
        if (outcome.status === "unknown") {
          log(routineLogLine(meta.id, ROUTINE_STEP_MENU, channel()));
          return { sent: false, recorded: false };
        }
      } catch {
        log(routineLogLine(meta.id, ROUTINE_STEP_MENU, channel()));
      }
    }
    return plain(text, meta);
  };
}
