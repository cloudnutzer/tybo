// Gesprächsseite eines Sprachagenten (/sa/<kennung>, Issue #494). Liegt hinter
// dem Login. „Sprechen“ holt beim Server das Gesprächs-Token
// (POST /api/voice-agents/<kennung>/session), lädt das selbst gehostete SDK
// des Anbieters (/vendor/elevenlabs/, erst beim Tipp) und verbindet über
// WebRTC mit genau diesem Token. Das Mikrofon fragt die Seite vor dem Token
// an, damit das Warten auf die Erlaubnis keinen Platz belegt. „Auflegen“
// beendet die Verbindung, wartet, bis der LiveKit-Raum des SDK wirklich
// getrennt ist, und meldet dann das Ende (POST …/session/end mit der
// Gesprächs-ID). Scheitert die Verbindung, meldet die Seite das Ende ebenso.
// Die Meldung ist nur ein Hinweis: Platz, Freigabe und Minuten gibt erst der
// Server frei, wenn ElevenLabs das Ende bestätigt; bis dahin antwortet er mit
// 202 ausstehend, und die Seite sagt das. Scheitert Trennen oder Meldung,
// bleibt der Knopf „Noch einmal auflegen“.
// Seit SA1-7 (Issue #495): Stumm (input.setMuted), Unterbrechen (sendUserActivity,
// nur während der Agent spricht), Wechsel zu einem anderen Sprachagenten legt
// erst auf und wartet auf den Abschluss, und je Browser läuft höchstens ein
// Gespräch (Web Locks über alle Tabs und die installierte App derselben Adresse).
// Die Sperre hält, bis ElevenLabs das Ende bestätigt; bis dahin fragt die Seite
// nach. Ohne oder mit gestörten Web Locks startet kein Gespräch. Stumm gilt
// erst, wenn das Umschalten abgeschlossen ist und die Mikrofonspur es zeigt,
// Unterbrechen erst, wenn das SDK es bestätigt; scheitert Stumm oder bleibt
// der Abschluss aus, endet das Gespräch.
// Liste, Rezept und Verwaltung stehen unter /sprachagenten (sprachagenten.js);
// die Auswahl „Anderer Sprachagent“ holt die Liste von dort.
"use strict";

const VOICE_AGENT_SDK = {
  script: "/vendor/elevenlabs/lib.iife.js",
  // Der WebRTC-Weg lädt nur dieses Worklet; aus blob: oder data: verböte es die CSP
  workletPaths: { rawAudioProcessor: "/vendor/elevenlabs/rawAudioProcessor.js" },
};

/** Name der Sperre, die je Browser ein Gespräch zulässt (Web Locks API) */
const VOICE_AGENT_LOCK_NAME = "tybo-sprachagent-gespraech";

/** So lange wartet die Seite höchstens auf das Trennen des LiveKit-Raums */
const VOICE_AGENT_DISCONNECT_TIMEOUT_MS = 15_000;

/** Antwortet die Web Locks API so lange nicht, gilt sie als gestört */
const VOICE_AGENT_LOCK_TIMEOUT_MS = 5_000;

/** Abstand der Nachfragen, solange ElevenLabs das Ende nicht bestätigt (202 ausstehend) */
const VOICE_AGENT_PENDING_CHECK_MS = 20_000;

/**
 * Stumm und wieder an gelten erst, wenn input.setMuted des SDK abgeschlossen
 * ist und die Mikrofonspur den neuen Stand zeigt. Bleibt der Abschluss so
 * lange aus, ist offen, ob das Mikrofon hört: Das Gespräch endet.
 */
const VOICE_AGENT_MUTE_TIMEOUT_MS = 5_000;

/**
 * sendUserActivity hält den Agenten nur vorübergehend an. Unterbrochen ist
 * erst, wenn das SDK onInterruption oder den Wechsel aufs Zuhören meldet; ohne
 * Bestätigung in dieser Frist sagt die Seite, dass er weiterspricht.
 */
const VOICE_AGENT_INTERRUPT_CONFIRM_MS = 3_000;

const VOICE_AGENT_TEXT = {
  loading: "Wird geladen …",
  loadFailed: "Der Zustand ließ sich nicht laden.",
  unknown: "Diesen Sprachagenten gibt es nicht.",
  notReady: "Gerade ist kein Gespräch möglich.",
  ready: "Bereit.",
  running: "Mit diesem Sprachagenten läuft gerade ein Gespräch, oder ElevenLabs hat das Ende des letzten noch nicht bestätigt. Lege im zugehörigen Tab auf und lade diese Seite später neu.",
  freeAt: (time) => `Spätestens um ${time} ist der Platz wieder frei.`,
  connecting: "Verbinde …",
  cancelling: "Lege auf …",
  listening: "Verbunden. Hört zu.",
  speaking: "Verbunden. Spricht.",
  muted: "Verbunden. Dein Mikrofon ist stumm.",
  otherTab: "In einem anderen Tab oder Fenster läuft schon ein Gespräch mit einem Sprachagenten. Lege dort auf und versuche es dann noch einmal.",
  lockMissing: "Dieser Browser kann nicht sicherstellen, dass nur ein Gespräch zur Zeit läuft (Web Locks fehlen). Öffne die Seite über HTTPS in einem aktuellen Browser.",
  lockFailed: "Die Sperre für ein Gespräch zur Zeit ließ sich nicht setzen. Lade die Seite neu und versuche es noch einmal.",
  lockLost: "Die Sperre für ein Gespräch zur Zeit ging verloren. Das Gespräch wurde sicherheitshalber beendet.",
  switchBlocked: "Erst muss das laufende Gespräch sicher getrennt sein. Lege noch einmal auf, dann klappt der Wechsel.",
  switchPending: "ElevenLabs hat das Ende des Gesprächs noch nicht bestätigt. Erst danach klappt der Wechsel; die Seite fragt weiter nach.",
  pendingCheck: "Die Seite fragt weiter nach. Ein neues Gespräch geht erst danach.",
  muting: "Verbunden. Schalte dein Mikrofon stumm …",
  unmuting: "Verbunden. Schalte dein Mikrofon wieder ein …",
  muteFailed: "Das Mikrofon ließ sich nicht umschalten. Das Gespräch wurde sicherheitshalber beendet.",
  interrupting: "Verbunden. Unterbreche …",
  interruptUnconfirmed: "Der Agent hat das Unterbrechen nicht bestätigt und spricht weiter. Am sichersten unterbrichst du ihn, indem du einfach sprichst.",
  ended: "Gespräch beendet.",
  endedMinutes: (minuten) => `Gespräch beendet, ${minuten} ${minuten === 1 ? "Minute" : "Minuten"} gebucht.`,
  offline: "Der Server ist nicht erreichbar. Bitte später noch einmal versuchen.",
  startFailed: "Das Gespräch ließ sich nicht starten.",
  connectFailed: "Die Verbindung zum Sprachagenten ist gescheitert. Prüfe Netz und Mikrofon und versuche es noch einmal.",
  micFailed: "Ohne Mikrofon gibt es kein Gespräch. Erlaube den Zugriff (am Handy nur über HTTPS) und versuche es noch einmal.",
  endPending: "Aufgelegt. ElevenLabs hat das Ende noch nicht bestätigt; bis dahin bleibt der Platz belegt.",
  endFailed: "Das Ende ließ sich nicht melden. Bitte noch einmal auflegen.",
  disconnectFailed: "Die Verbindung ließ sich nicht trennen. Bitte noch einmal auflegen. Der Gesprächsplatz bleibt belegt.",
  talk: "Sprechen",
  again: "Noch einmal sprechen",
  hangUp: "Auflegen",
  hangUpAgain: "Noch einmal auflegen",
  mute: "Stumm",
  unmute: "Stumm aus",
  interrupt: "Unterbrechen",
};

/** Kennung aus dem Pfad /sa/<kennung>; null bei allem anderen */
function voiceAgentKennung(pathname) {
  const match = /^\/sa\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(pathname || ""));
  return match ? match[1] : null;
}

/** Uhrzeit HH:MM aus einem ISO-Zeitpunkt; "" bei allem anderen */
function voiceAgentClock(iso) {
  const at = new Date(String(iso || ""));
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Satz zur Sperre, mit spätestem Ende, falls bekannt */
function voiceAgentRunningText(text, bis) {
  const time = voiceAgentClock(bis);
  return time ? `${text} ${VOICE_AGENT_TEXT.freeAt(time)}` : text;
}

function voiceAgentMinutesText(info) {
  const minuten = info && info.minuten;
  if (!minuten || typeof minuten.limit !== "number") return "";
  const used = typeof minuten.verbraucht === "number" ? minuten.verbraucht : "?";
  return `Minuten im Browser diesen Monat: ${used} von ${minuten.limit}, höchstens ${info.maxMinuten} je Gespräch.`;
}

/**
 * Lädt das SDK einmal und liefert ElevenLabsClient. Steht es schon im Fenster
 * (Attrappe im Browser-Durchlauf), wird nichts geladen.
 */
function createVoiceAgentSdkLoader(win, doc) {
  let loading = null;
  return function loadSdk() {
    if (win.ElevenLabsClient) return Promise.resolve(win.ElevenLabsClient);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = doc.createElement("script");
        script.src = VOICE_AGENT_SDK.script;
        script.onload = () => (win.ElevenLabsClient ? resolve(win.ElevenLabsClient) : reject(new Error("SDK ohne ElevenLabsClient")));
        script.onerror = () => reject(new Error("SDK nicht ladbar"));
        doc.head.appendChild(script);
      }).catch((error) => {
        loading = null;
        throw error;
      });
    }
    return loading;
  };
}

/** Mikrofon des Browsers; ohne mediaDevices (etwa HTTP am Handy) ein Fehler */
function requestVoiceAgentMicrophone(nav) {
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") return Promise.reject(new Error("kein Mikrofon"));
  return nav.mediaDevices.getUserMedia({ audio: true });
}

function stopVoiceAgentStream(stream) {
  try {
    if (stream && typeof stream.getTracks === "function") stream.getTracks().forEach((track) => track.stop());
  } catch {
    // Aufräumen darf nichts verhindern
  }
}

function defaultVoiceAgentTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return () => clearTimeout(handle);
}

/** Fehler der Sperre; lockReason "fehlt" (keine Web Locks) oder "fehler" (API gestört) */
function voiceAgentLockError(reason) {
  return Object.assign(new Error(`Web Locks: ${reason}`), { lockReason: reason });
}

/**
 * Ein Gespräch je Browser: Sperre über die Web Locks API, gilt für alle Tabs,
 * Fenster und die installierte App derselben Adresse und fällt mit dem Tab
 * weg, auch wenn er abstürzt. acquire(onLost) liefert eine Freigabefunktion
 * oder null, wenn ein anderer Tab die Sperre hält. Ohne Web Locks (etwa über
 * HTTP, wo es auch kein Mikrofon gibt), bei einem Fehler der API oder ohne
 * Antwort in VOICE_AGENT_LOCK_TIMEOUT_MS scheitert acquire (lockReason): Dann
 * startet kein Gespräch, statt still ohne Sperre zu laufen. Geht eine
 * gehaltene Sperre verloren (die API beendet die Anfrage vor der Freigabe),
 * ruft die Sperre onLost.
 */
function createVoiceAgentLock(locks, name, setTimer = defaultVoiceAgentTimer) {
  const lockName = name || VOICE_AGENT_LOCK_NAME;
  return function acquire(onLost) {
    if (!locks || typeof locks.request !== "function") return Promise.reject(voiceAgentLockError("fehlt"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let granted = false;
      let freed = false;
      let free = () => {};
      const held = new Promise((r) => {
        free = r;
      });
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        fn(value);
      };
      const lost = () => {
        if (granted && !freed && typeof onLost === "function") onLost();
      };
      const cancelTimeout = setTimer(() => {
        if (settled) return;
        // Eine spät doch erteilte Sperre wird sofort wieder freigegeben
        freed = true;
        free();
        settle(reject, voiceAgentLockError("fehler"));
      }, VOICE_AGENT_LOCK_TIMEOUT_MS);
      let request;
      try {
        request = locks.request(lockName, { ifAvailable: true }, (lock) => {
          if (settled) return undefined;
          if (!lock) {
            settle(resolve, null);
            return undefined;
          }
          granted = true;
          settle(resolve, () => {
            freed = true;
            free();
          });
          return held;
        });
      } catch {
        settle(reject, voiceAgentLockError("fehler"));
        return;
      }
      Promise.resolve(request).then(
        () => {
          // Erfüllt ohne Rückruf: Die API arbeitet nicht wie beschrieben
          settle(reject, voiceAgentLockError("fehler"));
          lost();
        },
        () => {
          settle(reject, voiceAgentLockError("fehler"));
          lost();
        }
      );
    });
  };
}

/**
 * Wartet, bis der LiveKit-Raum der Sitzung wirklich getrennt ist. Das SDK
 * ruft beim Beenden room.disconnect() ohne await auf; endSession() und
 * onDisconnect melden sich also, bevor der Transport zu ist. room.disconnect()
 * läuft im SDK unter einer Sperre: Ein zweiter Aufruf wartet auf den ersten und
 * kehrt bei einem getrennten Raum sofort zurück. Bestätigt gilt das Ende nur
 * bei room.state "disconnected"; ohne Raum, bei einem Fehler oder nach der
 * Zeitgrenze nicht.
 */
async function voiceAgentTransportClosed(session, timeoutMs, setTimer) {
  const room = session && session.connection && session.connection.room;
  if (!room || typeof room.disconnect !== "function") return false;
  let cancel = () => {};
  const timeout = new Promise((resolve) => {
    cancel = setTimer(() => resolve(), timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => room.disconnect()), timeout]);
  } catch {
    // unten entscheidet der Zustand des Raums
  } finally {
    cancel();
  }
  return room.state === "disconnected";
}

/**
 * Stand der Mikrofonspur im LiveKit-Raum des SDK: "stumm" (Spur stumm und
 * abgeschaltet oder beendet), "an" (Spur offen und live) oder null, wenn er
 * sich nicht feststellen lässt. Belegt den Abschluss von input.setMuted.
 */
function voiceAgentMicState(session) {
  const room = session && session.connection && session.connection.room;
  const participant = room && room.localParticipant;
  if (!participant || typeof participant.getTrackPublication !== "function") return null;
  const publication = participant.getTrackPublication("microphone");
  const track = publication && publication.track;
  const media = track && track.mediaStreamTrack;
  if (!media || typeof track.isMuted !== "boolean") return null;
  if (track.isMuted && (media.enabled === false || media.readyState === "ended")) return "stumm";
  if (!track.isMuted && media.enabled === true && media.readyState === "live") return "an";
  return null;
}

/**
 * Ablauf eines Gesprächs ohne DOM, testbar mit Attrappen.
 * options: kennung, fetch, loadSdk, onChange(state), toLogin(), log(text),
 * dazu optional requestMicrophone() (Standard der Seite: getUserMedia),
 * setTimer(fn, ms) liefert eine Abbruchfunktion, disconnectTimeoutMs,
 * pendingCheckMs, muteTimeoutMs, interruptConfirmMs, acquireLock(onLost)
 * (createVoiceAgentLock: Freigabefunktion, null, wenn ein anderer Tab
 * spricht, oder ein Fehler, wenn die Sperre nicht gesetzt werden kann).
 * Zustand: phase bereit | laeuft | verbinde | verbunden | beende | beendet | fehler,
 * dazu mode hoert | spricht, text (Fehler- oder Hinweissatz), minuten,
 * retryEnd (Ende nicht gemeldet, Auflegen wiederholen), ausstehend (Ende
 * gemeldet, von ElevenLabs noch nicht bestätigt; Versuch und Sperre bleiben,
 * die Seite fragt nach), muted (Mikrofon stumm, belegt durch die Mikrofonspur),
 * muteTarget (Umschalten läuft: true stumm, false wieder an, sonst null),
 * interrupting (Unterbrechen gesendet, noch nicht bestätigt), hint
 * (Hinweis während des Gesprächs).
 */
function createVoiceAgentCall(options) {
  const base = `/api/voice-agents/${options.kennung}`;
  const log = options.log || (() => {});
  const setTimer = options.setTimer || defaultVoiceAgentTimer;
  const disconnectTimeoutMs = options.disconnectTimeoutMs || VOICE_AGENT_DISCONNECT_TIMEOUT_MS;
  const pendingCheckMs = options.pendingCheckMs || VOICE_AGENT_PENDING_CHECK_MS;
  const muteTimeoutMs = options.muteTimeoutMs || VOICE_AGENT_MUTE_TIMEOUT_MS;
  const interruptConfirmMs = options.interruptConfirmMs || VOICE_AGENT_INTERRUPT_CONFIRM_MS;
  let state = {
    phase: "bereit",
    mode: "hoert",
    text: "",
    minuten: null,
    retryEnd: false,
    ausstehend: false,
    muted: false,
    muteTarget: null,
    interrupting: false,
    hint: "",
  };
  // Ein Kontext besitzt Token, SDK-Verbindung und Endemeldung vom Start bis
  // zum Abschluss. Er bleibt auch nach pagehide aktiv, bis eine ausstehende
  // Verbindung wirklich getrennt und ihr Ende bestätigt ist. Alte Rückrufe
  // dürfen ausschließlich ihren eigenen Kontext bearbeiten.
  let active = null;
  /** Wer auf den Abschluss wartet (idle) */
  let idleWaiters = [];

  /**
   * Ruhig: kein Versuch mehr, oder einer, der nur noch auf „Noch einmal
   * auflegen“ oder auf die Bestätigung von ElevenLabs wartet (busy bleibt dann true)
   */
  function isIdle() {
    return !active || ((state.retryEnd || state.ausstehend) && !active.ending);
  }

  function notifyIdle() {
    if (idleWaiters.length === 0 || !isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function set(next) {
    state = { ...state, ...next };
    options.onChange(state);
    notifyIdle();
  }

  /** Laufende Bestätigungen von Stumm und Unterbrechen verwerfen */
  function dropWaits(attempt) {
    for (const key of ["muteChange", "interruptWait"]) {
      const wait = attempt[key];
      attempt[key] = null;
      if (wait) wait.cancel();
    }
  }

  function cancelPendingCheck(attempt) {
    const cancel = attempt.cancelCheck;
    attempt.cancelCheck = null;
    if (cancel) cancel();
  }

  /** Versuch abschließen: Platz im Browser frei, Sperre der anderen Tabs auch */
  function release(attempt) {
    if (active === attempt) active = null;
    cancelPendingCheck(attempt);
    dropWaits(attempt);
    const free = attempt.release;
    attempt.release = null;
    if (free) {
      try {
        free();
      } catch {
        // Freigeben darf nichts verhindern
      }
    }
  }

  function post(path, body, keepalive) {
    return options.fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: Boolean(keepalive),
    });
  }

  /**
   * Meldet ausschließlich das eigene, bereits getrennte Gespräch. 202: Der
   * Server hat die Meldung, ElevenLabs bestätigt das Ende aber noch nicht.
   */
  async function reportEnd(attempt) {
    let res;
    try {
      res = await post(`${base}/session/end`, { conversationId: attempt.id }, attempt.left);
    } catch {
      return { ok: false, error: VOICE_AGENT_TEXT.endFailed };
    }
    const body = await res.json().catch(() => null);
    if (res.status === 401) {
      if (active === attempt && !attempt.left) options.toLogin();
      return { ok: false, error: VOICE_AGENT_TEXT.endFailed };
    }
    if (res.status === 202 || (body && body.ausstehend === true)) {
      return { ok: true, minuten: null, pending: voiceAgentRunningText((body && body.error) || VOICE_AGENT_TEXT.endPending, body && body.bis) };
    }
    if (res.ok) return { ok: true, minuten: body && typeof body.minuten === "number" ? body.minuten : null };
    if (res.status === 404) return { ok: true, minuten: null };
    return { ok: false, error: (body && body.error) || VOICE_AGENT_TEXT.endFailed };
  }

  /** Mikrofon des Versuchs freigeben; das SDK hält danach sein eigenes */
  function releaseMic(attempt) {
    const stream = attempt.mic;
    attempt.mic = null;
    stopVoiceAgentStream(stream);
  }

  /**
   * Ein einziger Ende-Ablauf je Versuch: erst SDK trennen und auf den
   * getrennten Raum warten, dann Server melden. Mikrofonanfrage, Tokenabruf
   * und startSession müssen erst zurückkehren; bis dahin bleiben Platz und
   * volle Minuten gebucht. SDK-Laden allein öffnet kein Gespräch.
   * Antwortet der Server 202 ausstehend, bleiben Versuch und Sperre bestehen:
   * Die Seite fragt alle pendingCheckMs nach (recheck true, ohne „Lege auf …“),
   * bis ElevenLabs das Ende bestätigt oder der Server das Gespräch nicht mehr
   * kennt (Ablauf). Erst dann ist ein neues Gespräch oder ein Wechsel möglich.
   */
  function finish(attempt, recheck = false) {
    if (active !== attempt) return Promise.resolve();
    if (attempt.ending) return attempt.ending;
    cancelPendingCheck(attempt);
    dropWaits(attempt);
    // Noch ohne Reservierung: sofort aufgeben, die Mikrofonanfrage räumt selbst auf
    if (attempt.step === "mic") {
      release(attempt);
      set({ phase: attempt.errorText ? "fehler" : "beendet", text: attempt.errorText || "", retryEnd: false, minuten: null, ausstehend: false });
      return Promise.resolve();
    }
    if (attempt.step === "token" || attempt.step === "connecting") return Promise.resolve();
    // startSession läuft nicht (mehr): Das Mikrofon der Seite wird nicht mehr gebraucht
    releaseMic(attempt);
    if (!recheck) set({ phase: "beende", text: "", retryEnd: false, muteTarget: null, interrupting: false, hint: "" });
    // Vor dem ersten SDK-Aufruf eingetragen, auch bei synchronem onDisconnect.
    attempt.ending = Promise.resolve().then(async () => {
      if (attempt.session) {
        try {
          await attempt.session.endSession();
        } catch {
          log("endSession: Trennen gescheitert");
          set({ phase: "fehler", text: VOICE_AGENT_TEXT.disconnectFailed, retryEnd: true });
          return;
        }
        // endSession kehrt vor dem Ende des Transports zurück: erst der
        // getrennte Raum gibt Platz, Freigabe und Minuten frei
        if (!(await voiceAgentTransportClosed(attempt.session, disconnectTimeoutMs, setTimer))) {
          log("Trennen: Raum nicht als getrennt bestätigt");
          if (active === attempt) set({ phase: "fehler", text: VOICE_AGENT_TEXT.disconnectFailed, retryEnd: true });
          return;
        }
        attempt.session = null;
      }
      const result = await reportEnd(attempt);
      if (active !== attempt) return;
      if (!result.ok) {
        // Eine gescheiterte Nachfrage ändert nichts: weiter ausstehend, später noch einmal
        if (recheck && state.ausstehend) {
          schedulePendingCheck(attempt);
          return;
        }
        set({ phase: "fehler", text: result.error, retryEnd: true });
        return;
      }
      const ausstehend = Boolean(result.pending);
      // Laut Server noch belegt: Sperre und Versuch bleiben, die Seite fragt nach
      if (ausstehend) schedulePendingCheck(attempt);
      else release(attempt);
      if (attempt.errorText) set({ phase: "fehler", text: ausstehend ? `${attempt.errorText} ${result.pending}` : attempt.errorText, retryEnd: false, minuten: result.minuten, ausstehend });
      else set({ phase: "beendet", text: result.pending || "", retryEnd: false, minuten: result.minuten, ausstehend });
    }).finally(() => {
      attempt.ending = null;
      // Wer auf den Abschluss wartet, bekommt auch einen Abbruch mit „Noch einmal auflegen“ mit
      notifyIdle();
    });
    return attempt.ending;
  }

  /** Nächste Nachfrage beim Server, solange ElevenLabs das Ende nicht bestätigt hat */
  function schedulePendingCheck(attempt) {
    cancelPendingCheck(attempt);
    attempt.cancelCheck = setTimer(() => {
      attempt.cancelCheck = null;
      if (active === attempt && !attempt.ending) finish(attempt, true);
    }, pendingCheckMs);
  }

  /**
   * Gespräch sicherheitshalber beenden (Stumm gescheitert, Sperre verloren):
   * derselbe Ablauf wie Auflegen, danach steht text als Fehler da.
   */
  function abort(attempt, text) {
    if (active !== attempt || attempt.cancelled || attempt.ending || state.ausstehend) return;
    attempt.errorText = text;
    attempt.cancelled = true;
    set({ phase: "beende", text: "", retryEnd: false, muteTarget: null, interrupting: false, hint: "" });
    finish(attempt);
  }

  /** Die Web Locks API hat die gehaltene Sperre beendet: kein Gespräch ohne Sperre */
  function lockLost(attempt) {
    if (active !== attempt) return;
    log("Sperre: verloren");
    attempt.release = null;
    abort(attempt, VOICE_AGENT_TEXT.lockLost);
  }

  /** Stumm oder wieder an ist gescheitert: Zustand unklar, also auflegen */
  function muteFailed(attempt) {
    if (active !== attempt) return;
    log("Stumm: SDK gescheitert");
    dropWaits(attempt);
    abort(attempt, VOICE_AGENT_TEXT.muteFailed);
  }

  /** Das SDK bestätigt das Zuhören (onInterruption oder Wechsel aufs Zuhören) */
  function listening(attempt) {
    const wait = attempt.interruptWait;
    attempt.interruptWait = null;
    if (wait) wait.cancel();
    set({ mode: "hoert", interrupting: false, hint: "" });
  }

  async function start() {
    if (active || state.phase === "laeuft") return;
    const attempt = {
      id: null,
      session: null,
      created: null,
      mic: null,
      step: "mic",
      cancelled: false,
      left: false,
      ending: null,
      errorText: "",
      release: null,
      cancelCheck: null,
      muteChange: null,
      interruptWait: null,
    };
    active = attempt;
    set({ phase: "verbinde", mode: "hoert", text: "", minuten: null, ausstehend: false, muted: false, muteTarget: null, interrupting: false, hint: "", retryEnd: false });
    // Ein Gespräch je Browser: Spricht ein anderer Tab, startet hier nichts.
    // Ohne oder mit gestörter Sperre auch nicht: Sonst liefe still ein zweites.
    if (options.acquireLock) {
      let free = null;
      let failure = "";
      try {
        free = await options.acquireLock(() => lockLost(attempt));
      } catch (error) {
        log(`Sperre: ${error && error.lockReason === "fehlt" ? "Web Locks fehlen" : "gestört"}`);
        failure = error && error.lockReason === "fehlt" ? VOICE_AGENT_TEXT.lockMissing : VOICE_AGENT_TEXT.lockFailed;
      }
      if (active !== attempt) {
        if (free) free();
        return;
      }
      if (failure || !free) {
        release(attempt);
        set({ phase: "fehler", text: failure || VOICE_AGENT_TEXT.otherTab });
        return;
      }
      attempt.release = free;
    }
    // Erst das Mikrofon: Das Warten auf die Erlaubnis belegt keinen Platz
    if (options.requestMicrophone) {
      try {
        attempt.mic = await options.requestMicrophone();
      } catch {
        log("Mikrofon: nicht freigegeben");
        if (active !== attempt) return;
        release(attempt);
        set({ phase: "fehler", text: VOICE_AGENT_TEXT.micFailed });
        return;
      }
      if (active !== attempt || attempt.cancelled) {
        releaseMic(attempt);
        if (active === attempt) {
          release(attempt);
          set({ phase: "beendet", text: "", retryEnd: false, minuten: null, ausstehend: false });
        }
        return;
      }
    }
    attempt.step = "token";
    let res;
    let body = null;
    try {
      res = await post(`${base}/session`, {});
      body = await res.json().catch(() => null);
    } catch {
      releaseMic(attempt);
      release(attempt);
      set({ phase: "fehler", text: VOICE_AGENT_TEXT.offline });
      return;
    }
    if (res.status === 401) {
      releaseMic(attempt);
      release(attempt);
      if (!attempt.left) options.toLogin();
      set({ phase: "fehler", text: VOICE_AGENT_TEXT.startFailed });
      return;
    }
    if (!res.ok || !body || typeof body.conversationToken !== "string" || typeof body.conversationId !== "string") {
      releaseMic(attempt);
      release(attempt);
      const running = res.status === 409 && body && body.reason === "laeuft";
      set({
        phase: running ? "laeuft" : "fehler",
        text: running ? voiceAgentRunningText(VOICE_AGENT_TEXT.running, body.bis) : (body && body.error) || VOICE_AGENT_TEXT.startFailed,
      });
      return;
    }
    attempt.id = body.conversationId;
    attempt.step = "sdk";
    if (attempt.cancelled) {
      releaseMic(attempt);
      return finish(attempt);
    }
    try {
      const sdk = await options.loadSdk();
      if (active !== attempt || attempt.cancelled) {
        releaseMic(attempt);
        return;
      }
      attempt.step = "connecting";
      attempt.session = await sdk.Conversation.startSession({
        conversationToken: body.conversationToken,
        connectionType: "webrtc",
        workletPaths: VOICE_AGENT_SDK.workletPaths,
        // Scheitert startSession danach, gehört diese Sitzung trotzdem getrennt
        onConversationCreated: (conversation) => {
          attempt.created = conversation;
        },
        onModeChange: (event) => {
          if (active !== attempt || attempt.cancelled || state.phase !== "verbunden") return;
          if (event && event.mode === "speaking") set({ mode: "spricht" });
          else listening(attempt);
        },
        // Unterbrochen (per Stimme oder nach „Unterbrechen“): Das meldet ElevenLabs, die Anzeige wechselt aufs Zuhören
        onInterruption: () => {
          if (active === attempt && !attempt.cancelled && state.phase === "verbunden") listening(attempt);
        },
        // Der Agent legt auf oder die Verbindung reißt ab; eine verlassene
        // Sitzung beendet nie das Gespräch eines späteren Starts
        onDisconnect: () => {
          if (active !== attempt || attempt.ending) return;
          attempt.cancelled = true;
          set({ phase: "beende", text: "" });
          finish(attempt);
        },
        // Fehler eines Umschaltens über setMicMuted meldet das SDK nur hier
        // („Failed to set input muted state“); jeder Fehler während eines
        // Umschaltens zählt ebenso. Danach ist unklar, ob das Mikrofon offen ist.
        onError: (message) => {
          log(`SDK: ${message}`);
          if (active === attempt && (attempt.muteChange || /mute/i.test(String(message)))) muteFailed(attempt);
        },
      });
    } catch {
      log("Verbindung: Aufbau gescheitert");
      releaseMic(attempt);
      if (active !== attempt) return;
      // Eine schon angelegte Sitzung wird wie jede andere getrennt und abgewartet.
      // Ohne sie kann trotzdem ein Raum offen sein (Fehler vor
      // onConversationCreated): Das klärt der Server mit ElevenLabs.
      attempt.session = attempt.created;
      attempt.step = "failed";
      if (!attempt.cancelled) attempt.errorText = VOICE_AGENT_TEXT.connectFailed;
      attempt.cancelled = true;
      return finish(attempt);
    }
    releaseMic(attempt);
    attempt.step = "connected";
    if (attempt.cancelled) return finish(attempt);
    set({ phase: "verbunden", mode: "hoert" });
  }

  function hangUp() {
    if (!active) return Promise.resolve();
    active.cancelled = true;
    set({ phase: "beende", text: "", retryEnd: false });
    return finish(active);
  }

  /**
   * pagehide bittet denselben Ablauf ums Auflegen, mit keepalive für die
   * Endemeldung. Wird die Seite vorher entladen, bleiben Sperre und Minuten
   * konservativ stehen. Niemals einen noch laufenden SDK-Aufruf freigeben.
   */
  function leave() {
    if (!active) return Promise.resolve();
    active.left = true;
    return hangUp();
  }

  /** Beim Laden: ein Gespräch läuft laut Server (etwa aus einem geschlossenen Tab) */
  function markRunning() {
    if (state.phase === "bereit") set({ phase: "laeuft" });
  }

  /** Die verbundene Sitzung des aktiven Versuchs; sonst null */
  function connectedSession() {
    if (!active || active.cancelled || active.ending || state.phase !== "verbunden") return null;
    return active.session;
  }

  /**
   * Mikrofon stumm schalten bzw. wieder an; nur verbunden und nicht, solange
   * ein Umschalten läuft. false, wenn nichts geschah. setMicMuted des SDK
   * verwirft das Ergebnis, und input.isMuted() zeigt den Wunsch, nicht die
   * Spur (WebRTCConnection setzt das Flag vor dem asynchronen track.mute()).
   * Deshalb ruft die Seite input.setMuted selbst auf und wartet auf dessen
   * Abschluss. Bis dahin sagt die Anzeige „Schalte …“ (muteTarget); den neuen
   * Stand übernimmt sie erst, wenn danach die Mikrofonspur ihn zeigt
   * (voiceAgentMicState). Scheitert das Umschalten, zeigt die Spur etwas
   * anderes oder bleibt der Abschluss länger als muteTimeoutMs aus, ist offen,
   * ob das Mikrofon hört: Das Gespräch endet mit einem Satz dazu.
   */
  function setMuted(muted) {
    const session = connectedSession();
    const attempt = active;
    const input = session && session.input;
    if (!input || typeof input.setMuted !== "function" || attempt.muteChange) return false;
    const target = Boolean(muted);
    const change = { target, cancel: () => {} };
    attempt.muteChange = change;
    set({ muteTarget: target });
    let done;
    try {
      done = Promise.resolve(input.setMuted(target));
    } catch {
      muteFailed(attempt);
      return false;
    }
    change.cancel = setTimer(() => {
      if (active !== attempt || attempt.muteChange !== change) return;
      log("Stumm: Umschalten nicht abgeschlossen");
      muteFailed(attempt);
    }, muteTimeoutMs);
    done.then(
      () => {
        if (active !== attempt || attempt.muteChange !== change) return;
        if (voiceAgentMicState(session) !== (target ? "stumm" : "an")) {
          log("Stumm: Spur zeigt den Stand nicht");
          muteFailed(attempt);
          return;
        }
        attempt.muteChange = null;
        change.cancel();
        set({ muted: target, muteTarget: null });
      },
      // Auch eine späte Ablehnung beendet das Gespräch, solange es auf sie wartet
      () => {
        if (active === attempt && attempt.muteChange === change) muteFailed(attempt);
      }
    );
    return true;
  }

  /**
   * Unterbrechen, während der Agent spricht: sendUserActivity() bittet ihn
   * anzuhalten, belegt aber keinen Abbruch. Die Anzeige sagt „Unterbreche …“,
   * bis das SDK onInterruption oder den Wechsel aufs Zuhören meldet. Bleibt
   * das in interruptConfirmMs aus, bleibt sie beim Sprechen und sagt das; eine
   * spätere Bestätigung schaltet trotzdem aufs Zuhören.
   */
  function interrupt() {
    const session = connectedSession();
    const attempt = active;
    if (!session || state.mode !== "spricht" || attempt.interruptWait || typeof session.sendUserActivity !== "function") return false;
    try {
      session.sendUserActivity();
    } catch {
      log("Unterbrechen: SDK gescheitert");
      set({ hint: VOICE_AGENT_TEXT.interruptUnconfirmed });
      return false;
    }
    const wait = { cancel: () => {} };
    attempt.interruptWait = wait;
    set({ interrupting: true, hint: "" });
    wait.cancel = setTimer(() => {
      if (active !== attempt || attempt.interruptWait !== wait) return;
      attempt.interruptWait = null;
      log("Unterbrechen: keine Bestätigung des SDK");
      set({ interrupting: false, hint: VOICE_AGENT_TEXT.interruptUnconfirmed });
    }, interruptConfirmMs);
    return true;
  }

  /**
   * Wartet, bis kein Versuch mehr läuft, auch über Tokenabruf, SDK-Laden und
   * Verbindungsaufbau hinweg, oder bis nur noch „Noch einmal auflegen“ bleibt.
   */
  function idle() {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  return {
    start,
    hangUp,
    leave,
    markRunning,
    setMuted,
    interrupt,
    idle,
    /** true, solange ein Versuch Platz, Sperre oder Verbindung hält */
    get busy() {
      return active !== null;
    },
    get state() {
      return state;
    },
  };
}

/**
 * Wechsel zu einem anderen Sprachagenten: erst auflegen und auf den
 * vollständigen Abschluss warten (auch mitten im Start), dann navigieren. Ist
 * die Verbindung danach nicht sicher getrennt (Noch einmal auflegen) oder hat
 * ElevenLabs das Ende noch nicht bestätigt (ausstehend: der Wechsel fragt
 * einmal nach), bleibt die Seite stehen und mit ihr die Sperre. Liefert true,
 * wenn navigiert wurde.
 */
async function switchVoiceAgent(call, url, navigate) {
  if (call.busy) {
    await call.hangUp();
    await call.idle();
  }
  if (call.busy) return false;
  navigate(url);
  return true;
}

/** Satz während des Gesprächs, ohne Hinweis */
function voiceAgentConnectedText(state) {
  if (state.muteTarget === true) return VOICE_AGENT_TEXT.muting;
  if (state.muteTarget === false) return VOICE_AGENT_TEXT.unmuting;
  if (state.interrupting) return VOICE_AGENT_TEXT.interrupting;
  if (state.mode === "spricht") return VOICE_AGENT_TEXT.speaking;
  return state.muted ? VOICE_AGENT_TEXT.muted : VOICE_AGENT_TEXT.listening;
}

/** Satz zum Zustand; info: GET /api/voice-agents/<kennung> */
function voiceAgentStatusText(state, info) {
  if (!info) return VOICE_AGENT_TEXT.loadFailed;
  const pending = (text) => (state.ausstehend ? `${text} ${VOICE_AGENT_TEXT.pendingCheck}` : text);
  switch (state.phase) {
    case "verbinde":
      return state.text || VOICE_AGENT_TEXT.connecting;
    case "beende":
      return VOICE_AGENT_TEXT.cancelling;
    case "verbunden":
      return state.hint ? `${voiceAgentConnectedText(state)} ${state.hint}` : voiceAgentConnectedText(state);
    case "beendet":
      if (state.text) return pending(state.text);
      return typeof state.minuten === "number" ? VOICE_AGENT_TEXT.endedMinutes(state.minuten) : VOICE_AGENT_TEXT.ended;
    case "fehler":
      return pending(state.text || VOICE_AGENT_TEXT.startFailed);
    case "laeuft":
      return state.text || VOICE_AGENT_TEXT.running;
  }
  if (info.laufend) return voiceAgentRunningText(VOICE_AGENT_TEXT.running, info.laufend.bis);
  if (info.bereit) return VOICE_AGENT_TEXT.ready;
  return String(info.grund || VOICE_AGENT_TEXT.notReady);
}

/**
 * Welche Knöpfe mit welcher Beschriftung; null: ausgeblendet. mute und
 * interrupt gibt es nur verbunden, interrupt nur, während der Agent spricht;
 * busy: Umschalten bzw. Unterbrechen wartet auf das SDK (Knopf gesperrt).
 * Solange ElevenLabs das Ende nicht bestätigt hat, gibt es kein neues Gespräch.
 */
function voiceAgentButtons(state, info) {
  const ready = Boolean(info && info.bereit);
  const none = { mute: null, interrupt: null, muteBusy: false, interruptBusy: false };
  if (state.retryEnd) return { talk: null, hangUp: VOICE_AGENT_TEXT.hangUpAgain, ...none };
  switch (state.phase) {
    case "verbinde":
      return { talk: null, hangUp: VOICE_AGENT_TEXT.hangUp, ...none };
    case "verbunden":
      return {
        talk: null,
        hangUp: VOICE_AGENT_TEXT.hangUp,
        mute: state.muted ? VOICE_AGENT_TEXT.unmute : VOICE_AGENT_TEXT.mute,
        interrupt: state.mode === "spricht" ? VOICE_AGENT_TEXT.interrupt : null,
        muteBusy: state.muteTarget !== null && state.muteTarget !== undefined,
        interruptBusy: Boolean(state.interrupting),
      };
    case "laeuft":
    case "beende":
      return { talk: null, hangUp: null, ...none };
    case "beendet":
    case "fehler":
      return { talk: ready && !state.ausstehend ? VOICE_AGENT_TEXT.again : null, hangUp: null, ...none };
  }
  return { talk: ready ? VOICE_AGENT_TEXT.talk : null, hangUp: null, ...none };
}

async function loadVoiceAgentInfo(kennung, isCurrent = () => true) {
  try {
    const res = await fetch(`/api/voice-agents/${kennung}`, { headers: { Accept: "application/json" }, credentials: "same-origin" });
    if (!isCurrent()) return null;
    if (res.status === 401) {
      window.location.href = "/login";
      return null;
    }
    const body = await res.json().catch(() => null);
    return res.ok ? body : { bereit: false, grund: body && body.error };
  } catch {
    return null;
  }
}

async function startVoiceAgentPage() {
  const kennung = voiceAgentKennung(window.location.pathname);
  const name = document.getElementById("agent-name");
  const status = document.getElementById("agent-status");
  const minutes = document.getElementById("agent-minutes");
  const talk = document.getElementById("agent-talk");
  const hangUp = document.getElementById("agent-hangup");
  const mute = document.getElementById("agent-mute");
  const interrupt = document.getElementById("agent-interrupt");
  if (!kennung) {
    status.textContent = VOICE_AGENT_TEXT.unknown;
    return;
  }
  let info = await loadVoiceAgentInfo(kennung);
  const render = (state) => {
    status.textContent = voiceAgentStatusText(state, info);
    document.body.dataset.phase = state.phase;
    const buttons = voiceAgentButtons(state, info);
    talk.hidden = !buttons.talk;
    talk.textContent = buttons.talk || "";
    hangUp.hidden = !buttons.hangUp;
    hangUp.textContent = buttons.hangUp || "";
    if (mute) {
      mute.hidden = !buttons.mute;
      mute.textContent = buttons.mute || "";
      mute.setAttribute("aria-pressed", state.muted ? "true" : "false");
      mute.disabled = buttons.muteBusy;
    }
    if (interrupt) {
      interrupt.hidden = !buttons.interrupt;
      interrupt.textContent = buttons.interrupt || "";
      interrupt.disabled = buttons.interruptBusy;
    }
    const text = voiceAgentMinutesText(info);
    minutes.textContent = text;
    minutes.hidden = !text;
  };
  const call = createVoiceAgentCall({
    kennung,
    fetch: (url, init) => fetch(url, init),
    loadSdk: createVoiceAgentSdkLoader(window, document),
    requestMicrophone: () => requestVoiceAgentMicrophone(window.navigator),
    // Ein Gespräch je Browser, über alle Tabs und die installierte App (Issue #495)
    acquireLock: createVoiceAgentLock(window.navigator && window.navigator.locks),
    toLogin: () => {
      window.location.href = "/login";
    },
    log: (text) => console.warn(`[sprachagent] ${text}`),
    onChange: async (state) => {
      render(state);
      // Nach dem Ende stimmen Minuten und Bereitschaft wieder mit dem Server
      if ((state.phase === "beendet" || state.phase === "fehler") && !state.retryEnd) {
        const updated = await loadVoiceAgentInfo(kennung, () => call.state === state);
        if (call.state !== state) return;
        info = updated || info;
        render(call.state);
      }
    },
  });
  if (info && info.name) {
    name.textContent = info.name;
    document.title = `${info.name} · ${document.title.split(" · ").pop()}`;
  }
  talk.addEventListener("click", () => call.start());
  hangUp.addEventListener("click", () => call.hangUp());
  if (mute) mute.addEventListener("click", () => call.setMuted(!call.state.muted));
  if (interrupt) interrupt.addEventListener("click", () => call.interrupt());
  setUpVoiceAgentSwitch(kennung, call);
  window.addEventListener("pagehide", () => call.leave());
  if (info && info.laufend) call.markRunning();
  render(call.state);
}

/**
 * Wechsel zu einem anderen Sprachagenten mit Web-Zugang (Issue #495). Die
 * Liste kommt aus der Verwaltung (GET /api/voice-agents); ohne sie oder ohne
 * zweiten Agenten bleibt die Auswahl verborgen. Ein Wechsel legt erst auf und
 * wartet auf den Abschluss (switchVoiceAgent); bleibt die Verbindung
 * ungetrennt, steht ein Satz da und die Auswahl springt zurück.
 */
async function setUpVoiceAgentSwitch(kennung, call) {
  const box = document.getElementById("agent-switch");
  const select = document.getElementById("agent-switch-select");
  const hint = document.getElementById("agent-switch-hint");
  if (!box || !select) return;
  let agents = [];
  try {
    const res = await fetch("/api/voice-agents", { headers: { Accept: "application/json" }, credentials: "same-origin" });
    const body = res.ok ? await res.json().catch(() => null) : null;
    agents = ((body && Array.isArray(body.agents) && body.agents) || []).filter((a) => a && a.web);
  } catch {
    return;
  }
  if (agents.length < 2) return;
  select.replaceChildren(
    ...agents.map((a) => {
      const option = document.createElement("option");
      option.value = a.kennung;
      option.textContent = a.name;
      option.selected = a.kennung === kennung;
      return option;
    })
  );
  box.hidden = false;
  select.addEventListener("change", async () => {
    const target = select.value;
    if (target === kennung) return;
    select.disabled = true;
    if (hint) hint.hidden = true;
    const moved = await switchVoiceAgent(call, `/sa/${target}`, (url) => {
      window.location.href = url;
    });
    if (moved) return;
    select.disabled = false;
    select.value = kennung;
    if (hint) {
      hint.textContent = call.state.ausstehend ? VOICE_AGENT_TEXT.switchPending : VOICE_AGENT_TEXT.switchBlocked;
      hint.hidden = false;
    }
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById("agent-status")) {
  startVoiceAgentPage();
}
