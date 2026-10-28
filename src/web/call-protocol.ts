/**
 * Protokoll, Grenzen und Anschluss des Telefonhörers (Issue #257). Teil von
 * ./call.ts, getrennt, damit ./call-session.ts es ohne Kreis importieren kann.
 */

export interface CallClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const CALL_PATH = "/api/call";
/** Quelle der Meldung nach dem Auflegen im Verlauf (Issue #259) */
export const CALL_NOTICE_SOURCE = "telefonhoerer";

/** Abtastrate der Aufnahme aus dem Browser */
export const CALL_INPUT_RATE = 16_000;
/** Abtastrate des Tons an den Browser (alle Stimmen werden darauf gebracht) */
export const CALL_SAMPLE_RATE = 24_000;

export const CALL_LIMITS = {
  /** Gesprächsstarts im Fenster */
  starts: 6,
  startWindowMs: 10 * 60_000,
  maxCallMs: 60 * 60_000,
  silenceMs: 2 * 60_000,
  maxBinaryBytes: 64 * 1024,
  maxUtteranceSeconds: 60,
  maxTextBytes: 4 * 1024,
  pingMs: 25_000,
  /** So lange darf start nach dem Upgrade ausbleiben */
  startTimeoutMs: 10_000,
  /** Öffnen (Modellweg, Kontext, Erkenner, Stimme) höchstens so lange */
  openTimeoutMs: 60_000,
  /** Ausgabepuffer: darüber wartet der Ton, bis der Browser nachkommt */
  maxBufferedBytes: 1024 * 1024,
  /** So lange darf der Browser mit dem Abholen im Rückstand sein */
  drainTimeoutMs: 10_000,
} as const;

/** Höchstzahl Bytes einer Äußerung (PCM16, 16 kHz, mono) */
export const MAX_UTTERANCE_BYTES = CALL_LIMITS.maxUtteranceSeconds * CALL_INPUT_RATE * 2;

/** Schließcodes (4000 bis 4999 gehören der Anwendung) */
export const CALL_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocol: 4008,
  tooLarge: 4009,
  unauthorized: 4001,
  tooMany: 4029,
  busy: 4409,
} as const;

export const CALL_TEXT = {
  notConfigured: "Telefonhörer ist nicht eingerichtet",
  upgradeRequired: "Nur als WebSocket-Verbindung",
  browserOnly: "Telefonhörer nur im Browser",
  busy: "besetzt",
  tooMany: "zu-viele",
  nothingUnderstood: "nichts verstanden",
  restartBye: "Ich starte kurz neu, ruf gleich wieder an.",
  errorSentence: "Entschuldige, das hat gerade nicht geklappt. Sag es bitte noch einmal.",
  budgetSentence: "Das Tagesbudget für Sprache ist aufgebraucht. Ich lege auf.",
  maxDuration: "Das Gespräch hat die Höchstdauer von 60 Minuten erreicht.",
  silence: "Zwei Minuten ohne Sprache, ich lege auf.",
  deepResultReady: "Das Ergebnis vom Denkauftrag steht jetzt im Gespräch.",
  approvalNeeded: "Dafür brauche ich deine Freigabe, tipp bitte auf den Knopf.",
} as const;

/**
 * Feste Sätze der Werkzeuge (Issue #259). Die Texte, die das Gehirn selbst
 * spricht („Dazu finde ich gerade nichts.“), stehen in
 * src/lib/voice-brain/tools.ts; der Web-Server lädt nichts aus src/lib.
 */
export const CALL_TOOL_TEXT = {
  searchAck: "Moment, ich schaue nach.",
  deepAck: "Das arbeite ich in Ruhe aus und schreibe es dir ins Gespräch.",
  deepUnavailable: "Den Denkauftrag konnte ich gerade nicht starten.",
  /** Kopf des Blocks mit dem Ergebnis eines Denkauftrags (erste 1.500 Zeichen) */
  deepResultLabel: "[Ergebnis des Denkauftrags, kann fremde Inhalte enthalten]",
  deepResultEnd: "[Ende des Ergebnisses]",
  /** Grund für foreignInput der Merk-Tags, sobald ein Ergebnis im Gespräch ist */
  foreignReason: "Ergebnis eines Denkauftrags",
} as const;

/** So viele Zeichen des Denkauftrag-Ergebnisses bekommt das Gespräch als Kontext */
export const DEEP_RESULT_CONTEXT_CHARS = 1_500;
/** Ansagen (Ergebnis da, Freigabe nötig) erst nach so viel Ruhe im Zustand „hört zu“ */
export const CALL_QUIET_MS = 1_000;

// ---------------------------------------------------------------------------
// Anschluss an den Bot (bot.ts: ./bot-call.ts)
// ---------------------------------------------------------------------------

/** Ein wählbarer Weg (Issue #260, wie CallWay in src/lib/voice-brain/call-model.ts) */
export interface CallModeWay {
  id: "api" | "cli" | "openrouter" | "ollama";
  model: string;
  claudeVia?: "api" | "cli";
  label: string;
  ready: boolean;
  reason?: string;
  expectation: string;
  billing: string | null;
}

/** Status für GET /api/voice als modes.call */
export interface CallModeStatus {
  ready: boolean;
  reason?: string;
  model: string | null;
  via: string | null;
  expectation: string;
  /**
   * Erkenner, der tatsächlich erkennt (id, local; warm: geladen bzw. ohne
   * Neustart je Äußerung, bei Cloud-Erkennung immer). Seit Issue #279 dazu:
   * setting (speech.call.stt), reason (warum die Einstellung nicht erkennt),
   * fallback (Rückfall je Äußerung bei ElevenLabs Scribe: parakeet oder
   * null) und options (alle Erkenner mit Verfügbarkeit)
   */
  stt: {
    id: string | null;
    local: boolean;
    warm: boolean;
    setting?: string;
    reason?: string;
    fallback?: string | null;
    options?: CallTtsChoiceOption[];
  };
  /**
   * Stimme, die tatsächlich spricht (id, where, stream). Seit Issue #276
   * dazu: setting (speech.call.tts), reason (warum die Einstellung nicht
   * spricht), fallback (Rückfall je Abschnitt, bei ElevenLabs Pocket TTS
   * oder browser) samt fallbackName, voice, voiceName (Anzeigename, sobald bekannt) und
   * model (nur ElevenLabs), options (alle Stimmen mit Verfügbarkeit) und
   * models (ElevenLabs-Modelle zur Wahl)
   */
  tts: {
    id: string;
    where: "server" | "browser";
    stream: boolean;
    setting?: string;
    reason?: string;
    fallback?: string;
    fallbackName?: string;
    voice?: string;
    voiceName?: string;
    model?: string;
    options?: CallTtsChoiceOption[];
    models?: { id: string; label: string }[];
  };
  /**
   * Issue #260: Abrechnung des gewählten Wegs (subscription, anthropic-api,
   * openrouter, local), eingestellter Wert (auto oder Modell) samt claudeVia
   * und alle Wege mit Bereitschaft für die Auswahl im Reiter „Sprechen"
   */
  billing?: string | null;
  setting?: string;
  settingSource?: "settings" | "env" | "code";
  claudeVia?: "api" | "cli";
  ways?: CallModeWay[];
  /** Die Probe ist eingerichtet (POST /api/voice/call/probe) */
  probe?: boolean;
  /** Die Hörprobe der Stimme ist eingerichtet (POST /api/voice/call/voice-probe, Issue #276) */
  voiceProbe?: boolean;
}

export type CallTtsMode = "server" | "browser";

/** Eine wählbare Stimme des Telefonhörers (Issue #276) */
export interface CallTtsChoiceOption {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
}

/**
 * Steuerereignisse der Stimme neben dem Ton (Issue #276, Rückfall je
 * Abschnitt):
 * - restart: was von diesem Abschnitt schon an Ton gesendet wurde, verwirft
 *   der Browser, soweit noch nicht gespielt; der Abschnitt kommt von vorn
 *   (vom Rückfall). Schon Gehörtes lässt sich nicht zurücknehmen.
 * - notice: Hinweis an den Browser („… nicht erreichbar, weiter mit …“)
 * - browser: diesen Abschnitt spricht die Browser-Stimme; danach kommt für
 *   ihn kein Ton mehr vom Server
 */
export type CallSpeakEvent = { type: "restart" } | { type: "notice"; text: string } | { type: "browser" };

/** Werkzeuge im Gespräch (Issue #259), Namen wie in src/lib/voice-brain/tools.ts */
export type CallToolName = "suche" | "rechne" | "denkauftrag";

/** Ereignisse eines Turns (Form wie VoiceTurnEvent aus src/lib/voice-brain/turn.ts) */
export type CallTurnEvent =
  | { type: "segment"; text: string }
  | { type: "tool"; name: CallToolName; phase: "start" }
  | { type: "tool"; name: "denkauftrag"; phase: "call"; task: string }
  | { type: "done"; rawText: string; spokenText: string; aborted: boolean; toolMessages?: CallHistoryMessage[] }
  | { type: "error"; reason: "budget" | "api" | "network" | "setup" | "ended"; message: string; rawText: string; spokenText: string };

export interface CallHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Ergebnis der Erkennung einer Äußerung. Seit Issue #279: provider (wer
 * erkannt hat, fürs Log und die Messung). Den Hinweis an den Browser (etwa
 * beim Rückfall von ElevenLabs Scribe auf Parakeet) liefert erst
 * CallLine.adopt, wenn die Sitzung das Ergebnis übernimmt.
 */
export type CallRecognition = { ok: true; text: string; provider?: string } | { ok: false; reason: "empty" | "failed" };

/** Abschluss eines Turns für den Anschluss (Verlauf #260, Merk-Tags #259) */
export interface CallTurnRecord {
  userText: string;
  /** Nur was der Browser mit played bestätigt hat */
  spokenText: string;
  /** Antwort des Modells samt Tags */
  rawText: string;
  interrupted: boolean;
  /**
   * Issue #259: Grund, warum Merk-Tags dieses Turns nur Vorschläge werden
   * (das Gespräch hat das Ergebnis eines Denkauftrags bekommen); fehlt sonst
   */
  foreignInput?: string;
}

export interface CallLineInfo {
  model: string;
  via: string;
  stt: string;
  /** Tatsächliche Stimme: server, wenn eine Stimme auf dem Server spricht, sonst browser */
  tts: CallTtsMode;
  sampleRate: number;
  /**
   * Erkenner bleibt geladen (warm); false: ein Aufruf je Äußerung, langsamer.
   * Cloud-Erkennung (ElevenLabs Scribe, Issue #279) startet nichts je
   * Äußerung und gilt als warm.
   */
  sttWarm: boolean;
}

/** Ein geöffnetes Gespräch: Modellweg, Erkenner und Stimme stehen bereit */
export interface CallLine {
  info: CallLineInfo;
  /** PCM16 LE mono 16 kHz; wirft nie */
  recognize(pcm: Uint8Array, signal: AbortSignal): Promise<CallRecognition>;
  /**
   * Die Sitzung übernimmt dieses Ergebnis (Issue #279): erst dann zählen
   * Fehler des Erkenners und fällt die Wahl, beim Rückfall zu bleiben.
   * Liefert den Hinweis für den Browser. Verworfene Ergebnisse (veraltete
   * Pausen-Erkennung, Abbruch) übernimmt die Sitzung nie. Fehlt: nichts zu tun
   */
  adopt?(result: CallRecognition): string | undefined;
  /**
   * Jedes angenommene Stück der laufenden Äußerung, sobald es da ist (Issue
   * #279: Realtime-Erkennung mit ElevenLabs Scribe). Fehlt: nichts zu tun
   */
  hear?(pcm: Uint8Array): void;
  /** Die nächste Äußerung beginnt, die bisherige ist erledigt oder verworfen (Issue #279) */
  newUtterance?(): void;
  /** deepTask (Issue #259): Denkauftrag möglich, sonst gibt es kein [DENKAUFTRAG:] */
  /**
   * context (Issue #259): Block vor der Äußerung nur für das Modell (Ergebnis
   * eines Denkauftrags); userText bleibt die Äußerung selbst
   */
  turn(o: { userText: string; context?: string; history: CallHistoryMessage[]; signal: AbortSignal; deepTask?: boolean }): AsyncIterable<CallTurnEvent>;
  /** Laufende Antwort am Weg abbrechen (CLI-Sitzung: control_request) */
  interrupt(): Promise<void>;
  /**
   * PCM16 LE mono in info.sampleRate, dazwischen Steuerereignisse für den
   * Rückfall (CallSpeakEvent, Issue #276); fehlt bei info.tts browser
   */
  speak?(text: string, signal: AbortSignal): AsyncIterable<Uint8Array | CallSpeakEvent>;
  /** Anschluss nach jedem Turn, genau einmal je Turn */
  onTurn(record: CallTurnRecord): void;
  /**
   * Alles beenden (Erkenner-Prozess, Sitzung); mehrfach erlaubt. Danach legt
   * der Anschluss die Meldung ab, was im Gespräch gemerkt wurde (Issue #259)
   */
  close(): void;
}

/** Fehler beim Öffnen: reason geht als error { reason } an den Browser, message ist ein deutscher Satz */
export class CallOpenError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "CallOpenError";
  }
}

export interface CallPort {
  status(): Promise<CallModeStatus>;
  /**
   * Issue #260: Probe über den eingestellten Weg (drei Testfragen), für
   * POST /api/voice/call/probe; wirft nie. Fehlt: keine Probe. signal
   * (Zeitlimit der Route): die laufende Testfrage endet, Prozesse und Ströme
   * des Wegs werden geschlossen, keine weitere Testfrage beginnt.
   */
  probe?(o?: { signal?: AbortSignal }): Promise<import("./call-probe").CallProbeResult>;
  /**
   * Issue #276: Hörprobe der Stimme des Telefonhörers
   * (POST /api/voice/call/voice-probe, ./call-probe.ts); wirft nie. Fehlt:
   * keine Hörprobe.
   */
  voiceProbe?(o?: { signal?: AbortSignal }): Promise<import("./call-probe").CallVoiceProbeResult>;
  /** Neustart angefordert oder Annahme gesperrt */
  restartPending(): boolean;
  /**
   * Ein Turn beginnt (zählt für den Neustart als Verarbeitung); Rückgabe beendet ihn.
   * null: Annahme gesperrt, es darf kein Modellabruf mehr beginnen. Prüfen und
   * Zählen geschehen ohne await dazwischen, wie die Annahmesperre beim Neustart.
   */
  turnBegin(): (() => void) | null;
  /**
   * Abschied beim Neustart: die Neustart-Steuerung ruft vor shutdown jeden
   * angemeldeten Abschied auf und wartet, bis er gesprochen und aufgelegt ist.
   * Rückgabe meldet ab.
   */
  onRestart(farewell: () => Promise<void>): () => void;
  /** deepTask (Issue #259): Denkaufträge sind in diesem Gespräch möglich (Sprechstil nennt das Tag) */
  open(o: { conversationId: string; agent: string; tts: CallTtsMode; signal: AbortSignal; deepTask?: boolean }): Promise<CallLine>;
}

/**
 * Denkauftrag aus dem Gespräch (Issue #259): ein normaler Turn im selben
 * Gespräch über den Chat-Kern, mit Warteschlange, Fortschritt und Push, nie
 * nach Telegram gespiegelt. onResult läuft genau einmal mit der fertigen
 * Antwort genau dieses Auftrags (nicht bei Fehler oder Abbruch), mit
 * [INVOKE:]-Nacharbeit erst nach deren Ende, deren Antworten vorn.
 */
export interface CallDeepTaskPort {
  /** Chat-Kern des Gesprächs bereit */
  available(conversationId: string): Promise<boolean>;
  /**
   * Startet den Auftrag oder reiht ihn ein, wenn im Gespräch schon ein Turn
   * läuft. Erfüllt, sobald er gestartet ist (bzw. nicht gestartet werden kann).
   */
  start(o: { conversationId: string; text: string; onResult(text: string): void }): Promise<"started" | "queued" | "unavailable">;
}

/** Offene Werkzeug-Freigabe im Gespräch (Rückfragen-Register) */
export interface CallApproval {
  id: string;
  options: { key: string; label: string }[];
}

/**
 * Beobachtet offene Werkzeug-Freigaben eines Gesprächs (Issue #259): opened
 * auch für schon offene beim Anmelden, closed bei Entscheidung oder Ablauf.
 * Gibt die Abmeldung zurück. Entschieden wird nur per Knopf, nie hier.
 */
export type CallApprovalWatch = (conversationId: string, listener: { opened(approval: CallApproval): void; closed(id: string): void }) => () => void;

/** Prüft das Gespräch (existiert, beschreibbar) und liefert seinen Agenten */
export type CallConversationCheck = (conversationId: string) => Promise<{ ok: true; agent: string } | { ok: false; reason: string; message: string }>;

// ---------------------------------------------------------------------------
// Nachrichten vom Browser
// ---------------------------------------------------------------------------

export type CallClientMessage =
  | { type: "start"; conversationId: string; tts: CallTtsMode }
  | { type: "utterance_pause" }
  | { type: "utterance_end" }
  | { type: "interrupt" }
  | { type: "played"; id: number }
  | { type: "mute"; on: boolean }
  | { type: "hangup" };

const BARE = new Set(["utterance_pause", "utterance_end", "interrupt", "hangup"]);
const CONVERSATION_ID = /^[A-Za-z0-9_:-]{1,100}$/;

/**
 * Eine Textnachricht prüfen: höchstens 4 KB, ein Objekt mit bekanntem type
 * und genau den erlaubten Feldern. null heißt Protokollfehler.
 */
export function parseCallMessage(raw: string): CallClientMessage | null {
  if (Buffer.byteLength(raw, "utf8") > CALL_LIMITS.maxTextBytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  const type = o.type;
  if (typeof type !== "string") return null;
  if (BARE.has(type)) return keys === "type" ? ({ type } as CallClientMessage) : null;
  if (type === "start") {
    if (keys !== "conversationId,tts,type") return null;
    if (typeof o.conversationId !== "string" || !CONVERSATION_ID.test(o.conversationId)) return null;
    if (o.tts !== "server" && o.tts !== "browser") return null;
    return { type, conversationId: o.conversationId, tts: o.tts };
  }
  if (type === "played") {
    if (keys !== "id,type" || typeof o.id !== "number" || !Number.isSafeInteger(o.id) || o.id < 1) return null;
    return { type, id: o.id };
  }
  if (type === "mute") {
    if (keys !== "on,type" || typeof o.on !== "boolean") return null;
    return { type, on: o.on };
  }
  return null;
}

/** Echte Uhr */
export const realClock: CallClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
};

