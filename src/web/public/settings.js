// Einstellungsansicht der WebUI: Reiter „Agenten" mit Modell, Effort und
// zusätzlichen Anweisungen je Agent (Issue #38), System-Prompt, Board-Schalter,
// neuen, gelöschten und wiederhergestellten Agenten (Issue #51), „Modelle" mit Standard,
// Nebenmodellen und Fallback sowie „Status" mit „Jetzt neu starten" (Issue #39),
// „Schlüssel" zum Setzen, Ersetzen und Entfernen von .env-Werten (Issue #63),
// oben im Reiter „Agenten" der Abschnitt „Motor" mit Standard-Motor, Codex- und OpenCode-Einstellungen (Issue #129)
// und abweichenden Gesprächen (Issue #126), „Benachrichtigungen" für Web Push
// auf diesem Gerät aus push.js (Issue #225), „Sprechen" mit Anbietern fürs Hören
// und Sprechen, Sprache und Status des Sprechmodus (Issue #248), darunter der
// Abschnitt „Sprechmodus auf diesem Gerät" aus speech.js (Issue #250).
// Wird vor app.js geladen; app.js ruft createSettingsView() auf und übergibt
// api() (mit Umleitung zum Login bei 401), agentLabel() und onTab().
// Nutzertext, Modellnamen, Anweisungen und Meldungen kommen nur über
// textContent und value in die Seite, nie über innerHTML.
"use strict";

/** Adresse der Einstellungen; der Reiter ist der letzte Teil */
const SETTINGS_HASH = "#/einstellungen";
const SETTINGS_TABS = [
  { id: "agenten", label: "Agenten", ready: true },
  { id: "modelle", label: "Modelle", ready: true },
  { id: "sprechen", label: "Sprechen", ready: true },
  { id: "schluessel", label: "Schlüssel", ready: true },
  { id: "status", label: "Status", ready: true },
  // Routinen-Zentrale (Issue #284): nur lesend
  { id: "routinen", label: "Routinen", ready: true },
  // Erinnerungen (Issue #323): offene aller Gespräche, absagen
  { id: "erinnerungen", label: "Erinnerungen", ready: true },
  // Web Push (Issue #225): nur mit push.js (vor settings.js geladen)
  ...(typeof createPushSettings === "function" ? [{ id: "benachrichtigungen", label: "Benachrichtigungen", ready: true }] : []),
];
/** Auswahlwerte, die kein Modellname sein können (Modellnamen haben keine Leerzeichen am Rand) */
const MODEL_DEFAULT = " standard";
const MODEL_CUSTOM = " eigenes";
const EFFORT_DEFAULT = " standard";
/** Wie INSTRUCTION_MAX_CHARS in src/web/instructions.ts */
const INSTRUCTION_MAX = 1000;
/** So lange steht „Gespeichert." neben dem Knopf */
const SAVED_MS = 4000;

const SOURCE_LABELS = { settings: "allgemeine Einstellung", env: ".env", code: "Voreinstellung" };

/** Agenten verwalten (Issue #51): Grenzen wie in src/web/agent-catalog.ts */
const AGENT_ID = /^[a-z][a-z0-9-]{1,29}$/;
const PROMPT_MAX = 20000;
const DESCRIPTION_MAX = 200;
const GENERAL_AGENT = "general";
const AGENT_TEXT = {
  note: "Gilt ab der nächsten frischen Session des Agenten. In Telegram erzwingt /new im betroffenen Topic das sofort.",
  catalogFailed: "Agentenliste konnte nicht geladen werden.",
  promptFailed: "System-Prompt konnte nicht geladen werden.",
  promptEmpty: "System-Prompt darf nicht leer sein.",
  promptTooLong: "System-Prompt höchstens " + PROMPT_MAX.toLocaleString("de-DE") + " Zeichen.",
  promptControl: "System-Prompt darf außer Zeilenumbruch und Tab keine Steuerzeichen enthalten.",
  nameInvalid: "Kennung: a-z, 0-9 und -, 2 bis 30 Zeichen, beginnt mit einem Buchstaben.",
  descriptionInvalid: "Beschreibung: eine Zeile, 1 bis " + DESCRIPTION_MAX + " Zeichen, ohne Steuerzeichen.",
  usageFailed: "Betroffene Topics konnten nicht geladen werden. Ohne diese Liste wird nichts gelöscht.",
  generalBoard: "General leitet /board und nimmt nicht selbst teil.",
  boardHint: "An: Der Agent spricht bei /board mit. Gilt ab dem nächsten /board.",
};

/** Reiter „Modelle" (Issue #39) */
const AUX_PURPOSES = ["judge", "distill", "review", "threads", "call-summary"];
const AUX_LABELS = { judge: "Judge", distill: "Destillat", review: "Review", threads: "Offene Fäden", "call-summary": "Anruf-Zusammenfassung" };
const AUX_HINTS = {
  judge: "Entscheidet bei /goal nach jedem Schritt, ob weitergearbeitet wird.",
  distill: "Fasst beendete Sessions für das Gedächtnis zusammen. Setzt es eine Session fort, läuft es immer über Claude.",
  review: "Schlägt nach dem Ende einer Session Merk-Einträge und Routinen vor.",
  threads: "Erkennt Fragen am Ende einer Antwort und prüft, ob sie beantwortet sind.",
  "call-summary": "Fasst Telefonanrufe zusammen und erkennt darin einen Auftrag.",
};
/** Abschnitt „Offene Fäden" (Issue #293): Grenzen wie das Schema in src/lib/settings.ts */
const THREADS_DAYS_MAX = 14;
const THREADS_SETTINGS_TEXT = {
  get intro() { return window.TYBO_BRAND.name + " merkt sich Fragen, die am Ende einer Antwort offen bleiben, und erinnert daran im selben Gespräch."; },
  enabledHint: "Aus: keine neuen Fäden, keine Erinnerungen, kein Eintrag in der Seitenleiste. Gilt ab dem nächsten Turn, ohne Neustart.",
  daysHint: "Gilt für neue Fäden. Eine erkannte Frist kann früher erinnern.",
  quietHint: "In dieser Zeit (Zeitzone des Nutzers) kommt keine Erinnerung; sie wird danach nachgeholt.",
  quietSame: "Beginn und Ende der Ruhezeit müssen verschieden sein.",
};
/** Ruhezeit ohne eigenen Wert bzw. mit eigenen Zeiten */
const QUIET_DEFAULT = " standard";
const QUIET_OWN = "own";
const PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "ollama", label: "Ollama" },
];
const PROVIDER_DEFAULT = " standard";
/** Aux mit Anbieter, aber noch ohne Modell */
const MODEL_NONE = " wählen";
const OFFLINE_DEFAULT = " standard";
/** Ab so vielen Einträgen hat eine Liste ein Filterfeld */
const FILTER_MIN = 12;
/** Höchstens so viele Treffer stehen in der Auswahl */
const FILTER_SHOW_MAX = 200;
/** Felder je Abschnitt; gespeichert wird pro Abschnitt */
const GLOBAL_SECTIONS = {
  defaults: [{ key: "model", kind: "model", list: "claude" }, { key: "effort", kind: "effort" }],
  aux: AUX_PURPOSES.map(key => ({ key, kind: "aux" })),
  fallback: [
    { key: "openrouterModel", kind: "model", list: "openrouter" },
    { key: "ollamaModel", kind: "model", list: "ollama" },
    { key: "offlineOnly", kind: "offline" },
  ],
  /** Offene Fäden (Issue #293): an/aus wie „Nur offline", Tage 1 bis 14, Ruhezeit als { from, to } */
  threads: [
    { key: "enabled", kind: "offline" },
    { key: "remindDays", kind: "days" },
    { key: "quietHours", kind: "quiet" },
  ],
  /**
   * Abschnitt „Motor" (Issue #126, Entscheidung 0018). Die Felder liegen in
   * der Datei verschachtelt (engine.default, engine.codex.model …); das
   * Formular hält sie flach (engineFlat) und schreibt sie verschachtelt
   * zurück (enginePatch). engine.topics ändert nur „Auf Standard".
   */
  engine: [
    { key: "default", kind: "choice" },
    { key: "codexModel", kind: "text" },
    { key: "codexEffort", kind: "choice" },
    { key: "codexSandbox", kind: "sandbox" },
    // OpenCode (Issue #129): Modell aus `opencode models` oder frei, Variante frei mit Prüfung, Rechte
    { key: "opencodeModel", kind: "model", list: "opencode" },
    { key: "opencodeVariant", kind: "variant" },
    { key: "opencodePermission", kind: "permission" },
  ],
  /**
   * Reiter „Sprechen" (Issue #248): Anbieter fürs Hören und Sprechen, Sprache.
   * „Standard" entfernt den eigenen Wert (dann gilt SPEECH_STT/SPEECH_TTS aus
   * .env oder auto), „Automatisch" speichert auto ausdrücklich.
   */
  speech: [
    { key: "stt", kind: "choice" },
    { key: "tts", kind: "choice" },
    { key: "language", kind: "choice" },
    // Modell für gesprochene Fragen (Issue #249): aus den Listen von Claude und OpenCode oder frei
    { key: "model", kind: "model", list: "speech" },
    { key: "effort", kind: "effort" },
  ],
};
const LIST_LABELS = { claude: "Claude", openrouter: "OpenRouter", ollama: "Ollama", opencode: "OpenCode", speech: "Modell" };

/** Auswahlwert „Standard" beim Motor und beim Codex-Effort */
const CHOICE_DEFAULT = " standard";
/** Rechte-Stufe ohne eigenen Wert, wie DEFAULT_CODEX_SANDBOX in src/lib/settings.ts */
const SANDBOX_DEFAULT = "full";
const SANDBOX_LABELS = { "read-only": "Nur lesen", "workspace-write": "Projekt schreiben", full: "Voller Zugriff" };
/** Rechte von OpenCode ohne eigenen Wert, wie DEFAULT_OPENCODE_PERMISSION in src/lib/settings.ts */
const PERMISSION_DEFAULT = "auto";
const PERMISSION_LABELS = { auto: "Automatisch freigeben", "ask-deny": "Fragen ablehnen" };
/** Variante von OpenCode, wie OPENCODE_VARIANT_PATTERN in src/lib/settings.ts (ein Test gleicht ab) */
const VARIANT_PATTERN = /^[a-z0-9-]{1,20}$/;
/** Motoren, falls der Server keine nennt (ältere Antwort) */
const ENGINE_FALLBACK = [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }, { id: "opencode", label: "OpenCode" }];
/** Wo man sich anmeldet, je Motor */
const ENGINE_LOGIN = { claude: "im Terminal claude starten, dann /login", codex: "codex login im Terminal", opencode: "opencode auth login im Terminal", api: "ANTHROPIC_API_KEY in der .env setzen" };
const ENGINE_TEXT = {
  get intro() { return "Womit " + window.TYBO_BRAND.name + " antwortet. Der Standard gilt für jedes Gespräch ohne eigene Wahl; ein einzelnes Gespräch stellt /motor um."; },
  codexNote: "Leer heißt: Codex nimmt den Wert aus seiner eigenen Konfiguration. Gilt ab der nächsten Nachricht mit Codex.",
  opencodeNote: "Leer heißt: OpenCode nimmt Modell und Variante aus seiner eigenen Konfiguration. Gilt ab der nächsten Nachricht mit OpenCode. Anmeldung und Anbieter kommen aus OpenCode (opencode auth login).",
  opencodeNoList: "Keine Modell-Liste von OpenCode geladen. Eigenes Modell bleibt möglich.",
  variantHint: "Hängt vom Anbieter ab, etwa low, high, max oder thinking-8k. Leer: Standard von OpenCode.",
  variantInvalid: "Die Variante besteht aus 1 bis 20 Zeichen: Kleinbuchstaben, Ziffern und Bindestrich.",
  permissionNote: "Automatisch freigeben: OpenCode bestätigt seine Rückfragen selbst (--auto), was die OpenCode-Konfiguration ausdrücklich verbietet, bleibt verboten. Fragen ablehnen: jede Rückfrage von OpenCode wird abgelehnt, die Aktion unterbleibt.",
  sandboxNote: "Voller Zugriff: Codex darf wie Claude Code alles, was dein Benutzerkonto darf, auch außerhalb des Projekts Dateien ändern, Befehle ausführen und ins Netz. Projekt schreiben: ändert nur Dateien im Projektordner. Nur lesen: liest und antwortet, ändert nichts.",
  checking: "Verfügbarkeit wird geprüft …",
  failed: "Verfügbarkeit und abweichende Gespräche konnten nicht geladen werden.",
  availabilityUnknown: "Verfügbarkeit nicht ermittelbar.",
  overridesTitle: "Abweichende Gespräche",
  overridesHint: "Gespräche, die mit /motor einen eigenen Motor haben. „Auf Standard\" entfernt die Ausnahme; die nächste Nachricht beginnt dort eine neue Session, das Gedächtnis bleibt.",
  overridesEmpty: "Keine. Alle Gespräche nehmen den Standard.",
  gone: "Nicht mehr zuzuordnen",
  goneHint: "Das Gespräch gibt es in der WebUI nicht mehr (Topic gelöscht oder andere Gruppe).",
  resetDone: "Auf Standard gestellt.",
  offline: "Server nicht erreichbar, nichts geändert.",
  modelInvalid: "Der Modellname darf höchstens 200 Zeichen lang sein, ohne Leerzeichen und Steuerzeichen.",
};

/** Reiter „Sprechen" (Issue #248) */
const SPEECH_AUTO = "auto";
const LANGUAGE_LABELS = { de: "Deutsch", en: "Englisch" };
const SPEECH_TEXT = {
  get intro() { return "Womit " + window.TYBO_BRAND.name + " Sprache hört und spricht: Sprachnachrichten in Telegram, Sprachaufnahmen im Web-Chat, Sprachantworten und der Sprechmodus im Browser. Gilt ab der nächsten Aufnahme, ohne Neustart."; },
  recommended: "Empfohlen und privat: Hören mit Parakeet, Sprechen mit Pocket TTS und der deutschen Stimme Jürgen, beides auf deinem Rechner, ohne Kosten pro Minute. Einrichten im Terminal mit tybo setup sprache. ElevenLabs ist die optionale Cloud-Variante: kostet Guthaben, Aufnahme bzw. Text gehen an ElevenLabs.",
  auto: "Automatisch",
  autoStt: "Automatisch: der erste verfügbare Anbieter in der Reihenfolge Parakeet, whisper.cpp, ElevenLabs, Gemini. Scheitert einer, übernimmt der nächste, dann kann das Audio auch an einen Cloud-Anbieter gehen.",
  autoTts: "Automatisch: im Sprechmodus die Browser-Stimme. Telegram-Sprachantworten nutzen die Server-Stimmen (Qwen3-TTS, ElevenLabs, Gemini, der erste verfügbare).",
  browser: "Telegram-Sprachantworten nutzen weiter die Server-Stimmen.",
  language: "Automatisch erkennt die Sprache selbst. Eine feste Sprache gilt für whisper.cpp und Qwen3-TTS; ElevenLabs und Gemini erkennen sie weiter selbst.",
  fixed: "Fest gewählt: nur dieser Anbieter, auch wenn er gerade nicht verfügbar ist. Kein stilles Ausweichen auf einen anderen.",
  noOptions: "Die Anbieterliste ist nicht verfügbar. Gespeicherte Werte bleiben erhalten.",
  statusLoading: "Status des Sprechmodus wird geladen …",
  statusFailed: "Status des Sprechmodus nicht abrufbar.",
  modelLabel: "Modell für gesprochene Fragen",
  modelDefault: "Wie das Gespräch",
  model: "Gilt nur für gesprochene Fragen im Sprechmodus, etwa ein schnelles Modell für kurze Antworten. Getippte Nachrichten im selben Gespräch laufen weiter mit dem Modell des Gesprächs. Das Modell muss zum Motor des Gesprächs passen (Claude Code, Codex, OpenCode oder Anthropic API); passt es nicht, antwortet das Modell des Gesprächs und ein Hinweis erscheint einmal.",
  effortLabel: "Effort für gesprochene Fragen",
  effortDefault: "Standard (medium)",
  effort: "Gilt nur zusammen mit einem eigenen Modell und nur bei Claude Code. Codex und OpenCode behalten ihre Stufe.",
};

/**
 * Reiter „Sprechen", Abschnitt „Telefonhörer" (Issue #260): Stand aus
 * modes.call, Modellweg (speech.call.model und claudeVia), Probe über
 * POST /api/voice/call/probe. Werte wie in src/web/call-probe.ts. Seit
 * Issue #276 die Stimme (speech.call.tts, bei ElevenLabs Stimmen-Kennung
 * und Modell) mit Kosten- und Datenhinweis und einer Hörprobe über
 * POST /api/voice/call/voice-probe.
 */
const CALL_CHOICE_DEFAULT = "default";
const CALL_CHOICE_AUTO = "auto";
const CALL_CHOICE_CUSTOM = "custom";
const CALL_MODEL_PATTERN = /^(claude|openrouter|ollama):[A-Za-z0-9._:/@-]{1,100}$/;
const CALL_SETTINGS_TEXT = {
  title: "Telefonhörer",
  intro: "Ein flüssiges Gespräch mit kurzen Antworten, ohne Telefonnummer. Arbeit, die Zeit braucht, gibt der Telefonhörer als Denkauftrag ins Gespräch. Kein Advanced Voice Mode: zwischen deinem Satz und der Antwort liegen rund zwei bis drei Sekunden.",
  loading: "Status des Telefonhörers wird geladen …",
  nextStep: "Nächster Schritt: im Terminal tybo setup sprache ausführen.",
  insecure: "Dieses Gerät erreicht tybo nicht über einen sicheren Zugang (HTTPS oder localhost). Ohne ihn gibt der Browser das Mikrofon nicht frei.",
  insecureStep: "Nächster Schritt: im Terminal tybo setup zugang ausführen.",
  noStt: "Kein lokaler Erkenner eingerichtet (Parakeet oder whisper.cpp).",
  noWay: "Kein Modellweg bereit.",
  modelLabel: "Modell im Gespräch",
  default: "Standard (automatisch)",
  auto: "Automatisch",
  custom: "Eigenes Modell …",
  customLabel: "Eigenes Modell",
  customHint: "Format: claude:<modell>, openrouter:<modell> oder ollama:<modell>.",
  customInvalid: "Bitte im Format claude:<modell>, openrouter:<modell> oder ollama:<modell> eingeben.",
  notReady: " (nicht bereit)",
  subscription: "Zählt gegen das Agent-SDK-Guthaben deines Abos.",
  apiKeyCli: "Claude Code läuft hier mit eigenem API-Schlüssel (CLAUDE_AUTH=apiKey bzw. gesetzter ANTHROPIC_API_KEY): das kostet nach Verbrauch, nicht über das Abo.",
  costs: "Kostet nach Verbrauch.",
  probe: "Probe",
  probeBusy: "Probe läuft …",
  probeHint: "Drei Testfragen über den eingestellten Weg. Höchstens drei Proben in zehn Minuten.",
  probeOffline: "Server nicht erreichbar, keine Probe.",
  voiceRef: "Hören und Sprechen bei „Automatisch“ richten sich nach „Hören und Sprechen“ oben.",
  browserVoice: "Ins Wort fallen per Stimme geht nur mit einer Stimme vom Server.",
  // Stimme des Telefonhörers (Issue #276)
  ttsLabel: "Stimme im Gespräch",
  ttsUnavailable: " (nicht wählbar)",
  ttsAuto: "Automatisch heißt: Pocket TTS oder Piper, wenn sie oben unter „Sprechen“ gewählt sind, sonst die Browser-Stimme.",
  elevenCost: "Kosten: ElevenLabs zieht für jedes gesprochene Zeichen Guthaben von deinem ElevenLabs-Konto ab.",
  elevenData: "Datenschutz: Jeder Antwortsatz geht als Text an ElevenLabs.",
  elevenKey: "Der Schlüssel bleibt ELEVENLABS_API_KEY unter „Schlüssel“, nie in den Einstellungen.",
  elevenFallback: "Ist ElevenLabs nicht erreichbar, spricht der Satz mit Pocket TTS weiter, nach zwei Fehlern in Folge bis zum Auflegen.",
  elevenNoFallback: "Ist ElevenLabs nicht erreichbar, spricht die Browser-Stimme den Satz (Pocket TTS ist nicht eingerichtet).",
  voiceIdLabel: "Stimmen-Kennung bei ElevenLabs",
  voiceIdHint: "Leer lassen für die voreingestellte Stimme. Die Kennung steht bei ElevenLabs unter Voices, „ID“.",
  voiceIdInvalid: "Die Stimmen-Kennung besteht nur aus Buchstaben, Ziffern, _ und -.",
  modelLabel11: "Modell bei ElevenLabs",
  modelDefault11: "Standard (v3 Conversational, am natürlichsten)",
  listen: "Stimme anhören",
  listenBusy: "Hörprobe läuft …",
  listenHint: "Ein kurzer Satz mit der gespeicherten Stimme, ohne Rückfall. Höchstens sechs Hörproben in zehn Minuten.",
  listenFailed: "Die Hörprobe ist gescheitert.",
  // Erkenner des Telefonhörers (Issue #279)
  sttLabel: "Erkennen im Gespräch",
  sttAuto: "Automatisch heißt: wie oben unter „Hören“, im Telefonhörer aber nur lokal (Parakeet oder whisper.cpp).",
  scribeData: "Datenschutz: Jede Äußerung im Gespräch geht als Aufnahme an ElevenLabs.",
  scribeCost: "Kosten: ElevenLabs berechnet die Erkennung nach Länge der Aufnahme und zieht dafür Guthaben von deinem ElevenLabs-Konto ab.",
  scribeKey: "Der Schlüssel bleibt ELEVENLABS_API_KEY unter „Schlüssel“, nie in den Einstellungen.",
  scribeFallback: "Ist ElevenLabs Scribe nicht erreichbar, erkennt Parakeet dieselbe Äußerung, nach zwei Fehlern in Folge bis zum Auflegen.",
  scribeNoFallback: "Ist ElevenLabs Scribe nicht erreichbar, gibt es keinen Rückfall (Parakeet ist nicht eingerichtet): tybo bittet dann, es noch einmal zu sagen.",
};
const CALL_VOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CALL_TTS_DEFAULT = "auto";
const CALL_STT_DEFAULT = "auto";

/** Reiter „Status" (Issue #39): Abfragen nach „Jetzt neu starten" */
const STATUS_POLL_MS = 3000;
const STATUS_POLL_SLOW_MS = 10000;
/** So lange wird schnell gefragt, danach langsamer */
const STATUS_POLL_FAST_FOR_MS = 60000;
/** Danach wird nicht mehr von selbst gefragt */
const STATUS_POLL_MAX_MS = 30 * 60000;
/** Routinen nach verlorener Antwort neu laden (Issue #288): Abstand und Höchstzahl der Versuche */
const ROUTINE_RELOAD_MS = 5000;
const ROUTINE_RELOAD_TRIES = 60;

/** Kennung eines Auftrags (Issue #288): derselbe POST handelt auf dem Server nur einmal */
function routineRequestId() {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/** Reiter „Routinen" (Issue #284), Texte wie /routinen in src/lib/routines/format.ts */
const ROUTINES_TEXT = {
  intro: "Zeitgesteuerte Dienste dieses Rechners mit Zeitplan, Status, letztem und nächstem Lauf. Ein Tipp auf eine Routine zeigt ihre letzten Läufe und die Knöpfe zum Testen, Pausieren und Fortsetzen.",
  unavailable: "Routinen: auf diesem System nicht verfügbar (weder launchd noch systemd noch PM2).",
  none: "Keine Routinen gefunden.",
  failed: "Routinen konnten nicht geladen werden.",
  daemons: "Dauerdienste",
  ownHint: "Eigene Dienste mit anderem Namen erscheinen, wenn sie in config/routines.json stehen (Vorlage: config/routines.example.json).",
  // Knöpfe (Issue #288); die Liste in Telegram verweist auf /routinen <name>
  pending: null,
  actions: { run: "▶️ Jetzt testen", pause: "⏸️ Pausieren", resume: "▶️ Fortsetzen" },
  confirmYes: { pause: "Ja, pausieren", resume: "Ja, fortsetzen" },
  confirmQuestion: { pause: name => name + " wirklich pausieren?", resume: name => name + " wirklich fortsetzen?" },
  confirmExplain: { pause: "Sie läuft dann nicht mehr, bis du fortsetzt.", resume: "Sie läuft dann wieder nach ihrem Zeitplan." },
  actBusy: "Wird ausgeführt …",
  actFailed: "Die Aktion ist fehlgeschlagen.",
  // Antwort verloren (Issue #288): die Aktion kann trotzdem gelaufen sein
  actUnknown: "Keine Antwort vom Server: ob die Aktion ausgeführt wurde, ist unbekannt. Der Zustand wird neu geladen, sobald der Server erreichbar ist.",
  actUnknownReloaded: "Keine Antwort vom Server: ob die Aktion ausgeführt wurde, war unbekannt. Oben steht der neu gelesene Zustand.",
  // Verlauf (Issue #285), wie ROUTINES_TEXT in src/lib/routines/format.ts
  notWrapped: "kein Verlauf (nicht eingebunden)",
  noRunYet: "noch keiner",
  noRuns: "Noch kein Lauf festgehalten.",
  runsLoading: "Verlauf lädt …",
  runsFailed: "Verlauf konnte nicht geladen werden.",
  tail: "Letzte Zeilen der Ausgabe",
  noTail: "Keine Ausgabe festgehalten.",
};
/** Reiter „Erinnerungen" (Issue #323), Texte wie /erinnerungen in src/lib/schedule/overview.ts */
const REMINDERS_TEXT = {
  intro: "Offene Erinnerungen aller Gespräche, nach Fälligkeit. Dieselbe Liste zeigt /erinnerungen in Telegram, im Browser und im Terminal.",
  none: "Keine offenen Erinnerungen.",
  failed: "Erinnerungen konnten nicht geladen werden.",
  cancel: "Absagen",
  confirmQuestion: text => "„" + text + "“ wirklich absagen?",
  confirmSeries: "Die ganze Serie endet, es kommen keine weiteren Termine.",
  confirmYes: "Ja, absagen",
  busy: "Wird abgesagt …",
  sending: "wird gerade zugestellt",
  overdue: "überfällig",
  offline: "Keine Antwort vom Server: ob abgesagt wurde, ist unbekannt. Die Liste wird neu geladen.",
};

const ROUTINE_STATE_TEXT = {
  active: "aktiv",
  paused: "pausiert",
  "not-loaded": "nicht geladen",
  running: "läuft",
  stopped: "läuft nicht",
  unknown: "Status unbekannt",
};

const SETTINGS_TEXT = {
  fileInvalid: "config/settings.json ist ungültig. Bis sie repariert oder gelöscht ist, gilt die letzte gültige Fassung, und Speichern ist nicht möglich.",
  loadFailed: "Einstellungen konnten nicht geladen werden.",
  showingLast: "Angezeigt ist der zuletzt geladene Stand, er kann veraltet sein.",
  offline: "Server nicht erreichbar, nichts gespeichert.",
  customMissing: "Bitte einen Modellnamen eingeben.",
  customInvalid: "Der Modellname darf höchstens 200 Zeichen lang sein, ohne Steuerzeichen.",
  instructionInvalid: "Eine Anweisung muss 1 bis " + INSTRUCTION_MAX + " Zeichen lang sein, ohne Steuerzeichen.",
  effortByModel: "Standard (richtet sich nach dem Modell)",
  modelNote:"Modell und Effort gelten ab der nächsten Nachricht an diesen Agenten. Ein anderes Modell beginnt dabei eine neue Session.",
  instructionsNote: "Wirkt ab dem nächsten neuen Gespräch dieses Agenten. Sofort: in Telegram im betroffenen Topic /new senden.",
  // Name aus /brand.js (Issue #100); Getter, damit er erst beim Gebrauch gelesen wird
  get restartNote() { return "Diese Änderung greift erst nach einem Neustart von " + window.TYBO_BRAND.name + "."; },
  auxModelMissing: "Bitte ein Modell wählen oder eingeben.",
  listsFailed: "Modelllisten konnten nicht geladen werden. Modellnamen lassen sich trotzdem eingeben.",
  statusFailed: "Status konnte nicht geladen werden.",
  get restartQuestion() { return window.TYBO_BRAND.name + " jetzt neu starten?"; },
  get restartExplain() { return window.TYBO_BRAND.name + " beendet erst die laufende Antwort, kündigt den Neustart in Telegram an und startet dann neu. Die Seite verbindet sich danach selbst wieder."; },
  restartWaiting: "Neustart nach der laufenden Antwort. Die Seite verbindet sich danach selbst neu.",
  get restartLost() { return "Verbindung getrennt, " + window.TYBO_BRAND.name + " startet neu …"; },
  get restartBack() { return window.TYBO_BRAND.name + " ist neu gestartet, die Seite ist wieder verbunden."; },
  restartTimeout: 'Noch kein Neustart erkannt. Vermutlich läuft noch eine Antwort. Mit „Aktualisieren" lässt sich später nachsehen.',
  restartOffline: "Server nicht erreichbar, kein Neustart angefordert.",
  keysNote: "Nur ob ein Wert gesetzt ist, nie der Wert selbst. Ändern lassen sich Schlüssel im Reiter „Schlüssel\".",
};

/**
 * Reiter „Schlüssel" (Issue #63, Schutzregeln aus SPEC.md). Ein Wert steht
 * nur im Passwortfeld und verlässt es nur im Body von PUT /api/keys/<name>;
 * er wird nie im Zustand, in Attributen oder in Meldungen gehalten.
 */
const KEYS_TEXT = {
  intro: "Werte aus der .env. Angezeigt wird nur, ob ein Wert gesetzt ist, bei langen Werten die letzten 4 Zeichen. Änderungen wirken nach einem Neustart.",
  loadFailed: "Schlüssel konnten nicht geladen werden.",
  get readOnly() { return "Schreibgeschützt. Zum Ändern WEB_ALLOW_KEY_EDIT=true in die .env eintragen und " + window.TYBO_BRAND.name + " neu starten."; },
  homeOnly: "Schlüssel ändern geht nur im Heimnetz. Von unterwegs sind sie nur lesbar.",
  get lockedNote() { return "Zugang zu WebUI und Telegram lässt sich hier nicht ändern, nur in der .env oder im Terminal mit „" + window.TYBO_BRAND.cli + " setup\"."; },
  locked: "Nur direkt in der .env",
  get restartNote() { return "Geänderte Schlüssel wirken erst nach einem Neustart von " + window.TYBO_BRAND.name + "."; },
  pending: "Neustart ausstehend",
  empty: "Bitte einen Wert eingeben.",
  offline: "Server nicht erreichbar, nichts geändert.",
  saved: "Gespeichert. Wirksam nach einem Neustart.",
  removed: "Entfernt. Wirksam nach einem Neustart.",
};

/**
 * Reiter aus der Adresse: "agenten" für #/einstellungen und
 * #/einstellungen/agenten. Nicht fertige oder unbekannte Reiter werden zu
 * "agenten". null, wenn die Adresse nicht zu den Einstellungen gehört.
 */
function settingsTabFromHash(hash) {
  const value = String(hash || "");
  if (value !== SETTINGS_HASH && !value.startsWith(SETTINGS_HASH + "/")) return null;
  const id = value.slice(SETTINGS_HASH.length + 1);
  const tab = SETTINGS_TABS.find(t => t.id === id && t.ready);
  return tab ? tab.id : "agenten";
}

function settingsHash(tab) {
  return SETTINGS_HASH + "/" + tab;
}

/** „Standard (claude-opus-5-5, Voreinstellung)"; ohne Effort: „Standard (Claude entscheidet)" */
function inheritedLabel(entry) {
  if (!entry || typeof entry !== "object") return "Standard";
  if (entry.value === null || entry.value === undefined || entry.value === "") return "Standard (Claude entscheidet)";
  const source = SOURCE_LABELS[entry.source];
  return "Standard (" + String(entry.value) + (source ? ", " + source : "") + ")";
}

/** Eigener Modellname: außen ohne Leerraum, 1 bis 200 Zeichen, keine Steuerzeichen; sonst null */
function normalizeModelName(value) {
  const clean = String(value == null ? "" : value).trim();
  if (!clean || clean.length > 200 || /\p{Cc}/u.test(clean)) return null;
  return clean;
}

/** Wie normalizeInstruction in src/web/instructions.ts; null, wenn ungültig */
function normalizeInstructionText(value) {
  const clean = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  const length = [...clean].length;
  if (length < 1 || length > INSTRUCTION_MAX) return null;
  if (/[^\P{Cc}\n\t]/u.test(clean)) return null;
  return clean;
}

/**
 * System-Prompt wie normalizePrompt in src/web/agent-catalog.ts: CRLF wird LF,
 * sonst unverändert. { value } oder { error }.
 */
function normalizePromptText(value) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  if (!text.trim()) return { error: AGENT_TEXT.promptEmpty };
  if (text.length > PROMPT_MAX) return { error: AGENT_TEXT.promptTooLong };
  if (/[^\P{Cc}\n\t]/u.test(text)) return { error: AGENT_TEXT.promptControl };
  return { value: text };
}

/** Beschreibung wie normalizeDescription im Server: eine Zeile, getrimmt; sonst null */
function normalizeDescriptionText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text || text.length > DESCRIPTION_MAX || /\p{Cc}/u.test(text)) return null;
  return text;
}

/**
 * Feld, zu dem eine Fehlermeldung des Servers beim Anlegen gehört: name,
 * description, prompt, model oder null (allgemein). Der Server liefert nur
 * Text, die Anfänge sind fest (AGENTS_TEXT in src/web/agent-catalog.ts).
 */
function createErrorField(status, text) {
  const t = String(text || "");
  if (/^(Kennung|Diese Kennung)/.test(t)) return "name";
  if (t.startsWith("Beschreibung")) return "description";
  if (t.startsWith("System-Prompt")) return "prompt";
  if (/^(Ungültige Einstellungen|Modell|Effort)/.test(t)) return "model";
  if (status === 409 && /Kennung/.test(t)) return "name";
  return null;
}

/**
 * Teiländerung für PATCH /api/settings aus Formular und gespeichertem Stand:
 * nur geänderte Felder, „Standard" als null (entfernt den eigenen Wert).
 * { patch } oder { patch: null } ohne Änderung oder { error } bei ungültigem
 * eigenen Modell.
 */
function agentSettingsPatch(form, own) {
  const saved = own && typeof own === "object" ? own : {};
  let model;
  if (form.model === MODEL_DEFAULT) model = null;
  else if (form.model === MODEL_CUSTOM) {
    if (!String(form.custom || "").trim()) return { error: SETTINGS_TEXT.customMissing };
    model = normalizeModelName(form.custom);
    if (model === null) return { error: SETTINGS_TEXT.customInvalid };
  } else model = form.model;
  const effort = form.effort === EFFORT_DEFAULT ? null : form.effort;
  const patch = {};
  if ((saved.model === undefined ? null : saved.model) !== model) patch.model = model;
  if ((saved.effort === undefined ? null : saved.effort) !== effort) patch.effort = effort;
  return { patch: Object.keys(patch).length ? patch : null };
}

/**
 * Welche Felder weichen vom gespeicherten Stand ab, unabhängig von der
 * Gültigkeit: ein leeres oder ungültiges eigenes Modell zählt als geändertes
 * Modell, der Effort wird trotzdem für sich verglichen. { model, effort }
 */
function agentFieldEdits(form, own) {
  const saved = own && typeof own === "object" ? own : {};
  const result = agentSettingsPatch(form, saved);
  const effort = form.effort === EFFORT_DEFAULT ? null : form.effort;
  return {
    model: !!result.error || !!(result.patch && "model" in result.patch),
    effort: (saved.effort === undefined ? null : saved.effort) !== effort,
  };
}

/**
 * true, wenn rev nicht älter ist als have ({ boot, seq } vom Server, siehe
 * src/web/revision.ts). boot ist der Prozessstart: ein späterer Prozess ist
 * neuer, ein früherer älter. Im selben Prozess heißt gleiche seq gleicher
 * Inhalt, höhere seq später gelesen. Ohne Nummer auf einer Seite: übernehmen.
 */
function isNotOlder(have, rev) {
  const valid = r => !!r && typeof r.boot === "number" && typeof r.seq === "number";
  if (!valid(have) || !valid(rev)) return true;
  if (rev.boot !== have.boot) return rev.boot > have.boot;
  return rev.seq >= have.seq;
}

// --- Reiter „Modelle": reine Hilfsfunktionen (Issue #39) ----------------------

/**
 * "anbieter:modell" am ersten Doppelpunkt zerlegen (ollama:qwen3:8b), wie
 * parseAuxSpec in src/lib/settings.ts. null, wenn es nicht passt.
 */
function splitAuxSpec(spec) {
  const value = String(spec == null ? "" : spec).trim();
  const sep = value.indexOf(":");
  if (sep <= 0) return null;
  const provider = value.slice(0, sep).toLowerCase();
  const model = value.slice(sep + 1).trim();
  if (!PROVIDERS.some(p => p.id === provider) || !model) return null;
  return { provider, model };
}

/**
 * Einträge einer Modell-Liste aus /api/models als [{ id, label }]. Claude
 * und Ollama liefern Texte, OpenRouter { id, name }; alles andere fällt weg.
 */
function listEntries(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const id = typeof entry === "string" ? entry : entry && typeof entry.id === "string" ? entry.id : null;
    if (!id || normalizeModelName(id) !== id || seen.has(id)) continue;
    seen.add(id);
    const name = entry && typeof entry === "object" && typeof entry.name === "string" ? entry.name.trim() : "";
    out.push({ id, label: name && name !== id ? name + " (" + id + ")" : id });
  }
  return out;
}

/**
 * Liste von `opencode models` (Issue #129): Kennungen unverändert, die
 * OpenRouter-Modelle zuerst (Anbieter des Maintainers, Entscheidung 0019),
 * sonst in der Reihenfolge von OpenCode. Gewählt wird dabei nichts: ohne
 * eigenen Wert bleibt „Standard aus der OpenCode-Konfiguration".
 */
function openCodeEntries(list) {
  const entries = listEntries(list);
  const first = entries.filter(e => e.id.startsWith("openrouter/"));
  return first.concat(entries.filter(e => !e.id.startsWith("openrouter/")));
}

/** Einträge, die zum Filtertext passen (ohne Groß-/Kleinschreibung, in ID und Name) */
function filterEntries(entries, filter) {
  const needle = String(filter || "").trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(e => e.id.toLowerCase().includes(needle) || e.label.toLowerCase().includes(needle));
}

/**
 * Formular eines Abschnittsfelds aus dem gespeicherten Wert. lists: je
 * Liste die IDs. Werte, die nicht in der Liste stehen, werden „Eigenes".
 */
function globalFieldState(spec, saved, lists) {
  if (spec.kind === "effort") return { choice: typeof saved === "string" ? saved : EFFORT_DEFAULT };
  if (spec.kind === "choice") return { choice: typeof saved === "string" ? saved : CHOICE_DEFAULT };
  if (spec.kind === "text") return { text: typeof saved === "string" ? saved : "" };
  if (spec.kind === "sandbox") return { choice: typeof saved === "string" ? saved : SANDBOX_DEFAULT };
  if (spec.kind === "permission") return { choice: typeof saved === "string" ? saved : PERMISSION_DEFAULT };
  if (spec.kind === "variant") return { text: typeof saved === "string" ? saved : "" };
  if (spec.kind === "offline") return { choice: saved === true ? "true" : saved === false ? "false" : OFFLINE_DEFAULT };
  if (spec.kind === "days") return { choice: typeof saved === "number" ? String(saved) : CHOICE_DEFAULT };
  if (spec.kind === "quiet") {
    const own = saved && typeof saved === "object" && Number.isInteger(saved.from) && Number.isInteger(saved.to);
    return own ? { mode: QUIET_OWN, from: String(saved.from), to: String(saved.to) } : { mode: QUIET_DEFAULT, from: "", to: "" };
  }
  const pick = (value, ids, empty) => {
    if (typeof value !== "string" || !value) return { choice: empty, custom: "", filter: "" };
    if (ids.includes(value)) return { choice: value, custom: "", filter: "" };
    return { choice: MODEL_CUSTOM, custom: value, filter: "" };
  };
  if (spec.kind === "model") return pick(saved, lists[spec.list] || [], MODEL_DEFAULT);
  const parsed = splitAuxSpec(saved);
  if (!parsed) return Object.assign({ provider: PROVIDER_DEFAULT }, pick(null, [], MODEL_NONE));
  return Object.assign({ provider: parsed.provider }, pick(parsed.model, lists[parsed.provider] || [], MODEL_NONE));
}

/**
 * Wert eines Abschnittsfelds für PATCH: { value } (null heißt „Standard",
 * entfernt den eigenen Wert) oder { error }.
 */
function globalFieldValue(spec, f) {
  if (spec.kind === "effort") return { value: f.choice === EFFORT_DEFAULT ? null : f.choice };
  if (spec.kind === "choice") return { value: f.choice === CHOICE_DEFAULT ? null : f.choice };
  // Voller Zugriff ist der Standard: ohne eigenen Wert gespeichert
  if (spec.kind === "sandbox") return { value: f.choice === SANDBOX_DEFAULT ? null : f.choice };
  // Automatisch freigeben ist der Standard: ohne eigenen Wert gespeichert
  if (spec.kind === "permission") return { value: f.choice === PERMISSION_DEFAULT ? null : f.choice };
  if (spec.kind === "variant") {
    const variant = String(f.text || "").trim();
    if (!variant) return { value: null };
    return VARIANT_PATTERN.test(variant) ? { value: variant } : { error: ENGINE_TEXT.variantInvalid };
  }
  if (spec.kind === "text") {
    if (!String(f.text || "").trim()) return { value: null };
    const name = normalizeModelName(f.text);
    return name === null || /\s/.test(name) ? { error: ENGINE_TEXT.modelInvalid } : { value: name };
  }
  if (spec.kind === "offline") return { value: f.choice === "true" ? true : f.choice === "false" ? false : null };
  if (spec.kind === "days") return { value: f.choice === CHOICE_DEFAULT ? null : Number(f.choice) };
  if (spec.kind === "quiet") {
    if (f.mode !== QUIET_OWN) return { value: null };
    const from = Number(f.from);
    const to = Number(f.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || f.from === "" || f.to === "") return { error: THREADS_SETTINGS_TEXT.quietSame };
    return from === to ? { error: THREADS_SETTINGS_TEXT.quietSame } : { value: { from, to } };
  }
  const model = () => {
    if (f.choice === MODEL_CUSTOM) {
      if (!String(f.custom || "").trim()) return { error: spec.kind === "aux" ? SETTINGS_TEXT.auxModelMissing : SETTINGS_TEXT.customMissing };
      const name = normalizeModelName(f.custom);
      return name === null ? { error: SETTINGS_TEXT.customInvalid } : { value: name };
    }
    if (f.choice === MODEL_NONE) return { error: SETTINGS_TEXT.auxModelMissing };
    return { value: f.choice === MODEL_DEFAULT ? null : f.choice };
  };
  if (spec.kind === "model") return model();
  if (f.provider === PROVIDER_DEFAULT) return { value: null };
  const result = model();
  return result.error ? result : { value: f.provider + ":" + result.value };
}

/**
 * Teiländerung eines Abschnitts für PATCH /api/settings: nur Felder, die vom
 * gespeicherten Stand abweichen. { patch } (null ohne Änderung) oder { error }.
 */
/** Gespeicherter Wert zum Vergleich: fehlt er, null; „Voller Zugriff" ist wie kein eigener Wert */
function savedFieldValue(spec, saved) {
  if (saved === undefined) return null;
  if (spec.kind === "sandbox" && saved === SANDBOX_DEFAULT) return null;
  if (spec.kind === "permission" && saved === PERMISSION_DEFAULT) return null;
  return saved;
}

function globalSectionPatch(section, fields, saved) {
  const own = saved && typeof saved === "object" ? saved : {};
  const patch = {};
  for (const spec of GLOBAL_SECTIONS[section] || []) {
    const result = globalFieldValue(spec, fields[spec.key]);
    if (result.error) return { error: result.error };
    const before = savedFieldValue(spec, own[spec.key]);
    if (!sameFieldValue(before, result.value)) patch[spec.key] = result.value;
  }
  return { patch: Object.keys(patch).length ? patch : null };
}

/** true, wenn das Feld vom gespeicherten Stand abweicht; ungültige Eingaben zählen als Änderung */
function globalFieldEdited(spec, f, saved) {
  if (!f) return false;
  const result = globalFieldValue(spec, f);
  if (result.error) return true;
  return !sameFieldValue(savedFieldValue(spec, saved), result.value);
}

/** Gleicher Wert; die Ruhezeit ist ein Objekt { from, to } und wird nach Inhalt verglichen */
function sameFieldValue(a, b) {
  if (a && b && typeof a === "object" && typeof b === "object") return a.from === b.from && a.to === b.to;
  return a === b;
}

/** Flache Formularfelder je Motor-Unterabschnitt und Feld in der Datei */
const ENGINE_SUBFIELDS = {
  codex: { codexModel: "model", codexEffort: "effort", codexSandbox: "sandbox" },
  opencode: { opencodeModel: "model", opencodeVariant: "variant", opencodePermission: "permission" },
};

/**
 * engine aus der Datei flach für das Formular: default, codexModel,
 * codexEffort, codexSandbox, opencodeModel, opencodeVariant, opencodePermission
 */
function engineFlat(engine) {
  const e = engine && typeof engine === "object" ? engine : {};
  const out = {};
  if (typeof e.default === "string") out.default = e.default;
  for (const [name, fields] of Object.entries(ENGINE_SUBFIELDS)) {
    const sub = e[name] && typeof e[name] === "object" ? e[name] : {};
    for (const [flat, key] of Object.entries(fields)) if (typeof sub[key] === "string") out[flat] = sub[key];
  }
  return out;
}

/** Flache Teiländerung des Formulars als PATCH-Form { default, codex: { … }, opencode: { model, variant, permission } } */
function enginePatch(flat) {
  const out = {};
  if ("default" in flat) out.default = flat.default;
  for (const [name, fields] of Object.entries(ENGINE_SUBFIELDS)) {
    const sub = {};
    for (const [key, target] of Object.entries(fields)) if (key in flat) sub[target] = flat[key];
    if (Object.keys(sub).length) out[name] = sub;
  }
  return out;
}

/**
 * Zeile der Verfügbarkeit eines Motors: „angemeldet, Version 2.1.281",
 * „nicht angemeldet: codex login im Terminal" usw. Ungeprüft ist nie
 * „angemeldet".
 */
function engineAvailabilityText(a) {
  if (!a || typeof a !== "object") return "unbekannt";
  const version = typeof a.version === "string" && a.version ? "Version " + a.version : "";
  if (a.installed !== true) return "nicht installiert";
  if (a.loggedIn === true) return "angemeldet" + (version ? ", " + version : "");
  if (a.loggedIn === false) return "nicht angemeldet: " + (ENGINE_LOGIN[a.engine] || "im Terminal anmelden") + (version ? " (" + version + ")" : "");
  return "installiert" + (version ? ", " + version : "") + "; Anmeldung nicht feststellbar";
}

// --- Reiter „Status": Anzeige-Hilfen (Issue #39) ------------------------------

/** Laufzeit in Worten: „unter einer Minute", „42 Min", „2 Std 17 Min", „3 Tage 4 Std" */
function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return "unter einer Minute";
  const minutes = Math.floor(s / 60) % 60;
  const hours = Math.floor(s / 3600) % 24;
  const days = Math.floor(s / 86400);
  if (days) return days + (days === 1 ? " Tag " : " Tage ") + hours + " Std";
  if (hours) return hours + " Std " + minutes + " Min";
  return minutes + " Min";
}

/** „4 gespeichert, 3 fortsetzbar"; null heißt unbekannt */
function formatSessions(sessions) {
  if (!sessions || typeof sessions !== "object") return "unbekannt";
  const stored = Number(sessions.stored) || 0;
  if (sessions.mode !== "resume") return "Session-Modus aus (" + stored + " gespeichert)";
  return stored + " gespeichert, " + (Number(sessions.resumable) || 0) + " fortsetzbar";
}

/**
 * Baut die Einstellungsansicht in die vorhandenen Elemente aus index.html.
 * deps: { api(method, path, body), agentLabel(name), setTimeout, clearTimeout,
 * onTab(tab), now(), onAgentsChanged(data, { topicsChanged }), topicTitle(chatId, topicId) }.
 * onTab setzt beim Wechsel des Reiters die Adresse und ruft show(tab); ohne
 * onTab ruft der Reiter show(tab) direkt. onAgentsChanged bekommt jeden
 * übernommenen Stand von /api/agents (data null: nur Topics neu holen),
 * topicTitle nennt den Namen eines Topics aus der Seitenleiste oder null.
 * Rückgabe: { show(tab), hide(), isOpen(), hasUnsavedChanges() }.
 */
function createSettingsView(deps) {
  const el = {
    view: document.getElementById("settings"),
    tabs: document.getElementById("settings-tabs"),
    notice: document.getElementById("settings-notice"),
    panel: document.getElementById("settings-panel"),
  };
  const later = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout || (id => clearTimeout(id));
  const now = deps.now || (() => Date.now());
  const state = {
    open: false,
    tab: "agenten",
    /** Nummer des laufenden Ladevorgangs, 0 ohne */
    loading: 0,
    /**
     * Abgleich mit dem Server. Jede Anfrage, die einen vollständigen Stand
     * liefert (GET beim Laden, PATCH beim Speichern), bekommt beim Absenden
     * eine Nummer. synced: höchste Nummer mit gültiger Antwort, failed:
     * höchste Nummer eines fehlgeschlagenen Ladens. Ist failed größer, ist der
     * angezeigte Stand nicht bestätigt; das steht immer sichtbar über den
     * Formularen, auch wenn schon Daten da sind (Codex-Befund Runde 7).
     */
    sync: { next: 0, synced: 0, failed: 0 },
    /** Antwort von GET/PATCH /api/settings */
    data: null,
    claudeModels: [],
    expanded: new Set(),
    /** Formular je Agent: { model, custom, effort, saving, error, saved, savedTimer, restart } */
    forms: new Map(),
    /** Anweisungen je Agent: { status, list, revision, error, text, busy, confirm, seq } */
    instructions: new Map(),
    /**
     * Version des zuletzt übernommenen Serverstands ({ boot, seq } aus
     * /api/settings). Übernommen wird ein Stand nur, wenn er nicht älter ist
     * (isNotOlder). Der Server versioniert den Inhalt, nicht die Anfrage: Auch
     * eine Änderung von Hand oder eine ungültig gewordene Datei ergibt eine
     * neue Nummer. So setzt eine verspätete Antwort mit älterem Stand, gleich
     * ob GET oder PATCH, nie einen neueren zurück.
     */
    revision: null,
    /**
     * Modell-Listen aus /api/models (Issue #39): Einträge [{ id, label }] je
     * Anbieter, dazu Fehlertexte je Anbieter (auch bei HTTP 200) und ob die
     * letzte Abfrage ganz scheiterte (bisherige Listen bleiben dann stehen).
     */
    lists: { claude: [], openrouter: [], ollama: [], opencode: [] },
    listErrors: { openrouter: null, ollama: null, opencode: null },
    listsFailed: false,
    /** Abschnitte im Reiter „Modelle": { fields, saving, error, saved, savedTimer, restart } */
    globals: new Map(),
    /**
     * Abschnitt „Motor" (Issue #126): GET /api/engines mit Standard,
     * Verfügbarkeit und abweichenden Gesprächen. seq verwirft überholte
     * Antworten; resetting: Schlüssel, der gerade auf Standard gestellt wird;
     * rowError/rowDone: Meldung zu genau einer Zeile { key, text }.
     */
    engines: { phase: "idle", data: null, error: null, seq: 0, resetting: null, rowError: null, notice: null },
    /** Status des Sprechmodus aus GET /api/voice (Issue #248): phase idle|loading|ok|failed */
    voice: { phase: "idle", data: null, seq: 0, call: null },
    /**
     * Abschnitt „Telefonhörer" (Issue #260): eigenes Formular für
     * speech.call.model und claudeVia (choice null: folgt dem Server),
     * Probe mit phase idle|busy|done
     */
    callForm: { choice: null, custom: "", tts: null, stt: null, voiceId: null, model: null, saving: false, error: null, saved: false, savedTimer: null, restart: null },
    callProbe: { phase: "idle", result: null, error: null },
    /** Hörprobe der Stimme (Issue #276): phase idle|busy|done, url des Tons (blob:) */
    callListen: { phase: "idle", url: "", error: null, autoplay: false, node: null },
    /** Reiter „Status": phase idle|loading|ok|failed, seq wie bei den Anweisungen */
    status: { phase: "idle", data: null, error: null, seq: 0 },
    /** Reiter „Routinen" (Issue #284): wie status; daemonsOpen: Dauerdienste aufgeklappt */
    /** Reiter „Erinnerungen" (Issue #323): wie status; act: Absage mit Rückfrage, step idle|confirm|busy */
    reminders: { phase: "idle", data: null, error: null, seq: 0, loading: false, act: { id: null, step: "idle" }, message: null, failed: false },
    routines: { phase: "idle", data: null, error: null, seq: 0, loading: false, daemonsOpen: false, openId: null, runs: { id: null, phase: "idle", data: null, error: null, seq: 0 }, act: { id: null, action: null, step: "idle", message: null, failed: false }, reload: { timer: null, tries: 0 } },
    /**
     * „Jetzt neu starten": step idle|confirm|busy|waiting|back|timeout|failed.
     * startedAt: Prozessstart vor dem Neustart; ein anderer heißt „neu
     * gestartet". lost: eine Abfrage ist seitdem gescheitert.
     */
    restartFlow: { step: "idle", message: null, startedAt: null, lost: false, since: 0, timer: null },
    /**
     * Agenten-Katalog aus GET /api/agents (Issue #51). Übernommen wird ein
     * Stand nur, wenn er nicht älter ist (isNotOlder mit revision), gleich ob
     * aus GET oder aus der Antwort auf Anlegen, Löschen, Wiederherstellen
     * oder den Board-Schalter. seq: nur das letzte Laden meldet Fehler.
     */
    catalog: { data: null, revision: null, status: "idle", error: null, seq: 0 },
    /**
     * System-Prompt je Agent: { status, data, revision, seq, error, editing,
     * draft, busy, saveError, confirmReset, saved, savedTimer }. Der Entwurf
     * (draft) gehört dem Browser: Kein Laden und keine Serverantwort ersetzt
     * ihn, nur Speichern (bestätigt) oder Abbrechen.
     */
    prompts: new Map(),
    /** Board-Schalter je Agent: { busy, pending, error, saved, savedTimer } */
    boards: new Map(),
    /** Löschen je Agent: { step idle|loading|failed|confirm|busy, topics, error, input, seq } */
    removals: new Map(),
    /** „Neuer Agent": Formular und Feldfehler */
    creating: null,
    /** Meldung oben im Reiter nach Anlegen, Löschen, Wiederherstellen: { kind: "ok" | "warn", text } */
    agentNotice: null,
    /** Kennung, die gerade wiederhergestellt wird, und Fehler dazu */
    restoring: null,
    restoreError: null,
    /**
     * Reiter „Schlüssel" (Issue #63): Liste aus GET /api/keys, seq verwirft
     * überholte Antworten (jedes Schreiben zählt mit). editors: offenes
     * Passwortfeld je Name { mode, input, busy, error }; das Feld selbst ist
     * das einzige, was den Wert kennt. confirm: Name mit offener
     * Löschrückfrage. rows: Meldung je Name { kind, text }. restart wie bei
     * den Formularen ({ status, message } oder null). pending: laufende
     * Schreibvorgänge je Name; overlapped: Namen, bei denen sich welche
     * überschnitten haben (Liste danach neu laden). reconcile: Namen, deren
     * Abgleich mit dem Server noch aussteht, bis eine Liste übernommen ist;
     * loadSeq: seq des zuletzt gestarteten Ladens.
     */
    keys: { phase: "idle", data: null, error: null, seq: 0, loadSeq: 0, loading: false, editors: new Map(), confirm: null, removing: null, rows: new Map(), restart: null, writes: new Map(), applied: new Map(), pending: new Map(), overlapped: new Set(), reconcile: new Set() },
  };

  /** Reiter „Benachrichtigungen" (Issue #225) aus push.js; ohne push.js gibt es ihn nicht */
  const pushSettings = typeof createPushSettings === "function"
    ? createPushSettings({ api: deps.api, win: window, storage: pushStorage(), render, h, sectionNode })
    : null;

  /**
   * Abschnitt „Sprechmodus auf diesem Gerät" (Issue #250) aus speech.js:
   * eigene Ablage in localStorage, nie Teil von PATCH /api/settings
   */
  const speechDevice = typeof createSpeechDeviceSettings === "function"
    ? createSpeechDeviceSettings({
      win: window,
      storage: pushStorage(),
      render,
      h,
      sectionNode,
      tts: () => (state.voice.data && typeof speechTtsPlace === "function" ? speechTtsPlace(state.voice.data) : null),
    })
    : null;

  /**
   * Abschnitt „Telefonhörer auf diesem Gerät" (Issue #258) aus call.js:
   * „Ins Wort fallen", eigene Ablage in localStorage, nie Teil von PATCH /api/settings
   */
  const callDevice = typeof createCallDeviceSettings === "function" && typeof speechSegment === "function"
    ? createCallDeviceSettings({ storage: pushStorage(), render, h, sectionNode, segment: speechSegment })
    : null;

  /**
   * Abschnitt „Eigene Stimme" (Issue #253) aus voice-clone.js: Einwilligung,
   * Aufnahme in tybo, Probe, Verwenden, Löschen. Nach Verwenden und Löschen
   * Einstellungen und Status des Sprechmodus neu laden.
   */
  const voiceClone = typeof createVoiceCloneSettings === "function"
    ? createVoiceCloneSettings({
      api: deps.api,
      win: window,
      render,
      h,
      sectionNode,
      changed: () => {
        void load();
        void loadVoice();
      },
    })
    : null;

  function pushStorage() {
    try {
      return window.localStorage || null;
    } catch {
      return null;
    }
  }

  // --- Bausteine ------------------------------------------------------------

  function h(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key === "hidden" || key === "disabled") node[key] = !!value;
      else if (key === "value") node.value = value;
      else if (key === "id") {
        node.id = value;
        node.setAttribute("id", value);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }

  function chevron() {
    if (typeof document.createElementNS !== "function") return null;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "chevron");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M6 9l6 6 6-6");
    svg.appendChild(path);
    return svg;
  }

  function focusedKey() {
    const active = document.activeElement;
    return active && typeof active.getAttribute === "function" ? active.getAttribute("data-focus-key") || null : null;
  }

  function focusKey(key) {
    if (!key || typeof document.querySelector !== "function") return;
    const target = document.querySelector('[data-focus-key="' + key.replace(/["\\]/g, "") + '"]');
    if (target && typeof target.focus === "function") target.focus();
  }

  function errorText(data, fallback) {
    return data && typeof data.error === "string" && data.error ? data.error : fallback;
  }

  // --- Daten ----------------------------------------------------------------

  /**
   * Agenten der Liste: aus dem Katalog, sobald er geladen ist (er entscheidet,
   * wer existiert, Issue #51), sonst aus /api/settings.
   */
  function agentNames() {
    const catalog = catalogAgents();
    if (catalog) return catalog.map(a => a.name);
    return state.data && Array.isArray(state.data.agents) ? state.data.agents.filter(n => typeof n === "string") : [];
  }

  /** Aktive Agenten aus dem Katalog oder null, solange keiner geladen ist */
  function catalogAgents() {
    const data = state.catalog.data;
    if (!data || !Array.isArray(data.agents)) return null;
    return data.agents.filter(a => a && typeof a.name === "string" && AGENT_ID.test(a.name));
  }

  function catalogEntry(name) {
    const list = catalogAgents();
    return list ? list.find(a => a.name === name) || null : null;
  }

  /** Anzeigename: aus dem Katalog, sonst wie in app.js */
  function labelOf(name) {
    const entry = catalogEntry(name);
    return entry && typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : deps.agentLabel(name) || name;
  }

  function ownEntry(name) {
    const agents = state.data && state.data.settings && state.data.settings.agents;
    return agents && typeof agents[name] === "object" && agents[name] ? agents[name] : {};
  }

  /** Formularwerte { model, custom, effort } aus dem gespeicherten Stand */
  function savedValues(name) {
    const own = ownEntry(name);
    let model = MODEL_DEFAULT;
    let custom = "";
    if (typeof own.model === "string") {
      if (state.claudeModels.includes(own.model)) model = own.model;
      else {
        model = MODEL_CUSTOM;
        custom = own.model;
      }
    }
    return { model, custom, effort: typeof own.effort === "string" ? own.effort : EFFORT_DEFAULT };
  }

  /** Formular aus dem gespeicherten Stand; Meldungen bleiben stehen */
  function resetForm(name) {
    const previous = state.forms.get(name) || {};
    state.forms.set(name, Object.assign(savedValues(name), {
      saving: false,
      error: null,
      saved: previous.saved || false,
      savedTimer: previous.savedTimer || null,
      restart: previous.restart || null,
    }));
  }

  function form(name) {
    if (!state.forms.has(name)) resetForm(name);
    return state.forms.get(name);
  }

  /** true, wenn der angezeigte Stand nach einem fehlgeschlagenen Laden nicht bestätigt ist */
  function isStale() {
    return state.sync.failed > state.sync.synced;
  }

  /**
   * Stand nur übernehmen, wenn er nicht älter ist als der zuletzt übernommene.
   * attempt: Nummer der Anfrage; auch ein älterer Stand bestätigt den Abgleich,
   * denn der angezeigte ist dann mindestens so neu.
   */
  function adoptIfNewer(settings, attempt, models, listsChanged) {
    if (models) state.claudeModels = models;
    if (attempt > state.sync.synced) state.sync.synced = attempt;
    if (!isNotOlder(state.revision, settings.revision)) {
      // Veraltet: nur die Modell-Listen können Formulare neu einordnen
      if ((models || listsChanged) && state.data) adoptServerData(state.data);
      return false;
    }
    if (settings.revision && typeof settings.revision.seq === "number") state.revision = settings.revision;
    adoptServerData(settings);
    return true;
  }

  /** Lädt den Stand; vorhandene Formulare und Eingaben bleiben dabei stehen */
  async function load() {
    const attempt = ++state.sync.next;
    state.loading = attempt;
    render();
    let settings = null;
    let models = [];
    let lists = null;
    try {
      const [s, m] = await Promise.all([
        deps.api("GET", "/api/settings"),
        deps.api("GET", "/api/models").catch(() => null),
      ]);
      if (s.ok && s.data && typeof s.data === "object") settings = s.data;
      if (m && m.ok && m.data && m.data.claude && Array.isArray(m.data.claude.models)) {
        models = m.data.claude.models.filter(x => typeof x === "string" && x);
      }
      if (m && m.ok && m.data && typeof m.data === "object") lists = m.data;
    } catch {
      // unten als Fehler gezeigt
    }
    if (state.loading === attempt) state.loading = 0;
    if (lists) adoptLists(lists);
    // Jeder gescheiterte Abruf zeigt den Hinweis; ältere Listen bleiben nutzbar
    else state.listsFailed = true;
    if (settings) adoptIfNewer(settings, attempt, models.length ? models : undefined, !!lists);
    else if (attempt > state.sync.failed) state.sync.failed = attempt;
    render();
  }

  /**
   * Neuen Serverstand übernehmen (nach GET und nach PATCH). Geänderte Felder
   * werden gegen den bisherigen Stand festgestellt, bevor er ersetzt wird:
   * unveränderte folgen dem Server, echte Eingaben bleiben stehen.
   * models: neue Claude-Liste oder undefined, dann bleibt die bisherige.
   */
  function adoptServerData(settings, models) {
    const edits = new Map();
    for (const [name, f] of state.forms) edits.set(name, agentFieldEdits(f, ownEntry(name)));
    const globalEdits = new Map();
    for (const [section, g] of state.globals) {
      const saved = savedGlobal(section);
      const edited = {};
      for (const spec of GLOBAL_SECTIONS[section]) edited[spec.key] = globalFieldEdited(spec, g.fields[spec.key], saved[spec.key]);
      globalEdits.set(section, edited);
    }
    state.data = settings;
    if (models) state.claudeModels = models;
    for (const name of agentNames()) {
      const f = state.forms.get(name);
      const edit = edits.get(name);
      if (!f || !edit) {
        resetForm(name);
        continue;
      }
      const fresh = savedValues(name);
      if (!edit.model) {
        f.model = fresh.model;
        f.custom = fresh.custom;
      }
      if (!edit.effort) f.effort = fresh.effort;
      if (!edit.model && !edit.effort) f.error = null;
    }
    // Abschnitte im Reiter „Modelle" genauso: unveränderte Felder folgen dem Server
    for (const [section, g] of state.globals) {
      const edited = globalEdits.get(section) || {};
      const saved = savedGlobal(section);
      for (const spec of GLOBAL_SECTIONS[section]) {
        if (edited[spec.key]) continue;
        const filter = g.fields[spec.key] && g.fields[spec.key].filter;
        g.fields[spec.key] = globalFieldState(spec, saved[spec.key], listIds());
        if (filter && "filter" in g.fields[spec.key]) g.fields[spec.key].filter = filter;
      }
      if (!Object.values(edited).some(Boolean)) g.error = null;
    }
  }

  // --- Reiter „Modelle" (Issue #39) ---------------------------------------------

  /** Listen aus /api/models übernehmen; Fehler je Anbieter bleiben als Text stehen */
  function adoptLists(data) {
    const errorOf = entry => (entry && typeof entry.error === "string" && entry.error ? entry.error : null);
    state.lists = {
      claude: listEntries(data.claude && data.claude.models),
      openrouter: listEntries(data.openrouter && data.openrouter.models),
      ollama: listEntries(data.ollama && data.ollama.models),
      opencode: openCodeEntries(data.opencode && data.opencode.models),
    };
    state.listErrors = { openrouter: errorOf(data.openrouter), ollama: errorOf(data.ollama), opencode: errorOf(data.opencode) };
    state.listsFailed = false;
  }

  function listIds() {
    return {
      claude: state.lists.claude.map(e => e.id),
      openrouter: state.lists.openrouter.map(e => e.id),
      ollama: state.lists.ollama.map(e => e.id),
      opencode: state.lists.opencode.map(e => e.id),
      speech: speechModelEntries().map(e => e.id),
    };
  }

  /** Modelle für gesprochene Fragen (Issue #249): die Listen von Claude und OpenCode; Codex hat keine Liste */
  function speechModelEntries() {
    const seen = new Set();
    return state.lists.claude.concat(state.lists.opencode).filter(e => !seen.has(e.id) && seen.add(e.id));
  }

  function savedGlobal(section) {
    const s = state.data && state.data.settings && state.data.settings[section];
    if (section === "engine") return engineFlat(s);
    return s && typeof s === "object" ? s : {};
  }

  function inheritedGlobal(section) {
    const inh = state.data && state.data.inheritedModels && state.data.inheritedModels[section];
    return inh && typeof inh === "object" ? inh : {};
  }

  /** Abschnitt aus dem gespeicherten Stand; Meldungen und Filtertexte bleiben */
  function resetGlobal(section) {
    const previous = state.globals.get(section) || {};
    const fields = {};
    for (const spec of GLOBAL_SECTIONS[section]) {
      fields[spec.key] = globalFieldState(spec, savedGlobal(section)[spec.key], listIds());
      const old = previous.fields && previous.fields[spec.key];
      if (old && old.filter && "filter" in fields[spec.key]) fields[spec.key].filter = old.filter;
    }
    state.globals.set(section, {
      fields,
      saving: false,
      error: null,
      saved: previous.saved || false,
      savedTimer: previous.savedTimer || null,
      restart: previous.restart || null,
    });
  }

  function globalForm(section) {
    if (!state.globals.has(section)) resetGlobal(section);
    return state.globals.get(section);
  }

  function isGlobalDirty(section) {
    const g = state.globals.get(section);
    if (!g) return false;
    const result = globalSectionPatch(section, g.fields, savedGlobal(section));
    return !!result.error || !!result.patch;
  }

  async function saveGlobal(section) {
    const g = globalForm(section);
    if (g.saving) return;
    const result = globalSectionPatch(section, g.fields, savedGlobal(section));
    if (result.error) {
      g.error = result.error;
      render();
      return;
    }
    if (!result.patch) return;
    g.saving = true;
    g.error = null;
    clearSaved(g);
    render();
    const body = {};
    body[section] = section === "engine" ? enginePatch(result.patch) : result.patch;
    const attempt = ++state.sync.next;
    let error = null;
    try {
      const { ok, data, status } = await deps.api("PATCH", "/api/settings", body);
      if (ok && data && typeof data === "object" && data.settings) {
        adoptIfNewer(data, attempt);
        resetGlobal(section);
        const next = globalForm(section);
        next.saved = true;
        next.savedTimer = later(() => {
          next.saved = false;
          next.savedTimer = null;
          render();
        }, SAVED_MS);
        next.restart = data.restartRequired === true ? { status: "idle", message: null } : null;
        render();
        // Standard-Motor geändert: Liste der abweichenden Gespräche neu (Issue #126)
        if (section === "engine") void loadEngines();
        // Hören und Sprechen geändert: Status des Sprechmodus neu (Issue #248)
        if (section === "speech") void loadVoice();
        // Offene Fäden an oder aus (Issue #293): Eintrag in der Seitenleiste nachführen
        if (section === "threads" && typeof deps.onThreadsChanged === "function") deps.onThreadsChanged();
        return;
      }
      error = errorText(data, "Speichern fehlgeschlagen (Fehler " + status + ").");
      if (status === 409 && state.data) state.data = Object.assign({}, state.data, { fileInvalid: true });
    } catch {
      error = SETTINGS_TEXT.offline;
    }
    g.saving = false;
    g.error = error;
    render();
  }

  // --- Reiter „Sprechen" (Issue #248) ------------------------------------------

  /** modes.local aus GET /api/voice; ein späteres Laden gewinnt */
  async function loadVoice() {
    const v = state.voice;
    const seq = ++v.seq;
    if (!v.data) v.phase = "loading";
    render();
    try {
      const res = await deps.api("GET", "/api/voice");
      if (seq !== v.seq) return;
      const local = res.ok && res.data && res.data.modes && res.data.modes.local;
      // Telefonhörer (Issue #258): nur ob der Server ihn kennt, für den Abschnitt pro Gerät
      if (res.ok && res.data && res.data.modes) v.call = res.data.modes.call && typeof res.data.modes.call === "object" ? res.data.modes.call : null;
      if (local && typeof local === "object" && typeof local.ready === "boolean") {
        v.data = local;
        v.phase = "ok";
      } else if (!v.data) v.phase = "failed";
    } catch {
      if (seq !== v.seq) return;
      if (!v.data) v.phase = "failed";
    }
    render();
  }

  // --- Abschnitt „Motor" (Issue #126) ------------------------------------------

  /** Stand aus GET /api/engines oder der Antwort auf „Auf Standard" übernehmen */
  function adoptEngines(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.overrides)) return false;
    state.engines.data = data;
    state.engines.phase = "ok";
    state.engines.error = null;
    return true;
  }

  async function loadEngines() {
    const e = state.engines;
    const seq = ++e.seq;
    if (!e.data) e.phase = "loading";
    render();
    let ok = false;
    try {
      const res = await deps.api("GET", "/api/engines");
      if (seq !== e.seq) return;
      ok = res.ok && adoptEngines(res.data);
      if (!ok) e.error = errorText(res.data, ENGINE_TEXT.failed);
    } catch {
      if (seq !== e.seq) return;
      e.error = ENGINE_TEXT.failed;
    }
    if (!ok && !e.data) e.phase = "failed";
    render();
  }

  /** „Auf Standard": entfernt genau die Ausnahme dieses Schlüssels */
  async function resetEngineOverride(key) {
    const e = state.engines;
    if (e.resetting) return;
    e.resetting = key;
    e.rowError = null;
    e.notice = null;
    const seq = ++e.seq;
    render();
    try {
      const res = await deps.api("POST", "/api/engines/reset", { key });
      if (res.ok && adoptEngines(res.data)) {
        e.notice = ENGINE_TEXT.resetDone;
      } else {
        // 404: gibt es nicht mehr; der mitgeschickte Stand ist dann der aktuelle
        if (res.status === 404) adoptEngines(res.data);
        e.rowError = { key, text: errorText(res.data, "Zurücksetzen fehlgeschlagen (Fehler " + res.status + ").") };
      }
    } catch {
      e.rowError = { key, text: ENGINE_TEXT.offline };
    }
    e.resetting = null;
    // Ein zwischendurch gestartetes Laden ist neuer als diese Antwort und gewinnt
    if (seq !== e.seq) return;
    render();
    focusKey("engine-reset-done");
  }

  // --- Reiter „Status" (Issue #39) ----------------------------------------------

  function stopStatusPoll() {
    const flow = state.restartFlow;
    if (flow.timer) cancel(flow.timer);
    flow.timer = null;
  }

  /**
   * Lädt /api/status. Nach „Jetzt neu starten" vergleicht es den Prozessstart:
   * ein anderer heißt, der Bot ist neu gestartet. Gilt auch ohne geöffnetes
   * Gespräch, das Chat-SSE ist dafür nicht nötig.
   */
  async function loadStatus() {
    const st = state.status;
    const seq = ++st.seq;
    if (st.phase !== "ok") st.phase = "loading";
    st.loading = true;
    render();
    let data = null;
    let error = null;
    try {
      const res = await deps.api("GET", "/api/status");
      if (res.ok && res.data && typeof res.data === "object") data = res.data;
      else error = errorText(res.data, SETTINGS_TEXT.statusFailed);
    } catch {
      error = SETTINGS_TEXT.statusFailed;
    }
    if (seq !== st.seq) return false;
    st.loading = false;
    const flow = state.restartFlow;
    if (data) {
      st.data = data;
      st.phase = "ok";
      st.error = null;
      if ((flow.step === "waiting" || flow.step === "timeout") && flow.startedAt && data.startedAt !== flow.startedAt) {
        stopStatusPoll();
        flow.step = "back";
        flow.message = SETTINGS_TEXT.restartBack;
      }
    } else {
      st.phase = st.data ? "ok" : "failed";
      st.error = error;
      if (flow.step === "waiting") flow.lost = true;
    }
    render();
    return !!data;
  }

  /** Routinen (Issue #284): nur lesend, bei jedem Öffnen des Reiters frisch */
  async function loadRoutines() {
    const r = state.routines;
    const seq = ++r.seq;
    if (r.phase !== "ok") r.phase = "loading";
    r.loading = true;
    render();
    let data = null;
    let error = null;
    try {
      const res = await deps.api("GET", "/api/routines");
      if (res.ok && res.data && typeof res.data === "object") data = res.data;
      else error = errorText(res.data, ROUTINES_TEXT.failed);
    } catch {
      error = ROUTINES_TEXT.failed;
    }
    if (seq !== r.seq) return;
    r.loading = false;
    if (data) {
      r.data = data;
      r.phase = "ok";
      r.error = null;
    } else {
      r.phase = r.data ? "ok" : "failed";
      r.error = error;
    }
    render();
  }

  /** Erinnerungen (Issue #323): bei jedem Öffnen des Reiters frisch */
  async function loadReminders() {
    const r = state.reminders;
    const seq = ++r.seq;
    if (r.phase !== "ok") r.phase = "loading";
    r.loading = true;
    render();
    let data = null;
    let error = null;
    try {
      const res = await deps.api("GET", "/api/reminders");
      if (res.ok && res.data && typeof res.data === "object" && Array.isArray(res.data.reminders)) data = res.data;
      else error = errorText(res.data, REMINDERS_TEXT.failed);
    } catch {
      error = REMINDERS_TEXT.failed;
    }
    if (seq !== r.seq) return;
    r.loading = false;
    if (data) {
      r.data = data;
      r.phase = "ok";
      r.error = null;
    } else {
      r.phase = r.data ? "ok" : "failed";
      r.error = error;
    }
    render();
  }

  /** „Absagen": erst nachfragen, dann POST /api/reminders/<id>/cancel, danach neu laden */
  function askCancelReminder(id) {
    const r = state.reminders;
    if (r.act.step === "busy") return;
    r.act = { id, step: "confirm" };
    r.message = null;
    render();
    focusKey("reminder-cancel-no");
  }

  function dropCancelReminder() {
    const r = state.reminders;
    const id = r.act.id;
    r.act = { id: null, step: "idle" };
    render();
    focusKey("reminder-" + String(id));
  }

  async function cancelReminder(id) {
    const r = state.reminders;
    if (r.act.step === "busy") return;
    r.act = { id, step: "busy" };
    render();
    let message = null;
    let failed = false;
    try {
      const res = await deps.api("POST", "/api/reminders/" + encodeURIComponent(id) + "/cancel", {});
      const text = res.data && typeof res.data === "object" ? (res.ok ? res.data.text : res.data.error) : null;
      message = typeof text === "string" && text ? text : res.ok ? "Abgesagt." : REMINDERS_TEXT.failed;
      failed = !res.ok;
    } catch {
      message = REMINDERS_TEXT.offline;
      failed = true;
    }
    r.act = { id: null, step: "idle" };
    r.message = message;
    r.failed = failed;
    await loadReminders();
    focusKey("reminders-refresh");
  }

  /** Verlauf einer Routine (Issue #285), beim Aufklappen frisch */
  async function loadRoutineRuns(id) {
    const v = state.routines.runs;
    const seq = ++v.seq;
    v.id = id;
    v.phase = "loading";
    v.data = null;
    v.error = null;
    render();
    let data = null;
    let error = null;
    try {
      const res = await deps.api("GET", "/api/routines/" + encodeURIComponent(id) + "/runs");
      if (res.ok && res.data && typeof res.data === "object" && Array.isArray(res.data.runs)) data = res.data;
      else error = errorText(res.data, ROUTINES_TEXT.runsFailed);
    } catch {
      error = ROUTINES_TEXT.runsFailed;
    }
    if (seq !== v.seq) return;
    v.phase = data ? "ok" : "failed";
    v.data = data;
    v.error = error;
    render();
  }

  /**
   * Knöpfe einer Routine (Issue #288): „Jetzt testen" sofort, Pausieren und
   * Fortsetzen erst nach dem Dialog. step: idle|confirm|busy.
   */
  function askRoutineAction(id, action) {
    const a = state.routines.act;
    if (a.step === "busy") return;
    if (action === "run") {
      void runRoutineAction(id, action);
      return;
    }
    Object.assign(a, { id, action, step: "confirm", message: null, failed: false });
    render();
    // Fokus auf „Abbrechen": ein zweites Enter pausiert nicht aus Versehen
    focusKey("routine-act-no");
  }

  function cancelRoutineAction() {
    const a = state.routines.act;
    if (a.step !== "confirm") return;
    const action = a.action;
    Object.assign(a, { step: "idle", action: null });
    render();
    focusKey("routine-act-" + action);
  }

  /**
   * POST /api/routines/<id>/<aktion>, pause und resume mit confirm, jede
   * Aktion mit einer neuen Kennung (request); danach der neu gelesene Zustand.
   * Geht die Antwort verloren, ist der Ausgang unbekannt: die Aktion kann
   * gelaufen sein. Dann Zustand neu laden, bis der Server antwortet.
   */
  async function runRoutineAction(id, action) {
    const r = state.routines;
    const a = r.act;
    if (a.step === "busy") return;
    Object.assign(a, { id, action, step: "busy", message: null, failed: false });
    render();
    let message = ROUTINES_TEXT.actFailed;
    let failed = true;
    let unknown = false;
    const request = routineRequestId();
    try {
      const res = await deps.api("POST", "/api/routines/" + encodeURIComponent(id) + "/" + action, action === "run" ? { request } : { confirm: true, request });
      const data = res.data && typeof res.data === "object" ? res.data : null;
      if (data && typeof data.text === "string" && data.text) {
        message = data.text;
        failed = !res.ok || ["failed", "partial", "blocked", "unknown", "unavailable"].includes(data.status);
        // Neu gelesener Zustand: Zeile sofort nachziehen
        if (data.routine && typeof data.routine === "object" && r.data && Array.isArray(r.data.routines)) {
          r.data.routines = r.data.routines.map(x => (x && x.id === data.routine.id ? data.routine : x));
        }
      } else message = errorText(data, ROUTINES_TEXT.actFailed);
    } catch {
      message = ROUTINES_TEXT.actUnknown;
      unknown = true;
    }
    Object.assign(a, { id, action: null, step: "idle", message, failed });
    render();
    focusKey("routine-" + String(id));
    if (unknown) {
      stopRoutineReload();
      void reloadAfterUnknown(id);
    }
  }

  function stopRoutineReload() {
    const re = state.routines.reload;
    if (re.timer !== null) cancel(re.timer);
    re.timer = null;
    re.tries = 0;
  }

  /** Nach verlorener Antwort: Liste (und offenen Verlauf) neu laden, bis das klappt */
  async function reloadAfterUnknown(id) {
    const r = state.routines;
    const re = r.reload;
    re.tries++;
    let ok = false;
    try {
      const res = await deps.api("GET", "/api/routines");
      if (res.ok && res.data && typeof res.data === "object") {
        r.data = res.data;
        r.phase = "ok";
        r.error = null;
        r.seq++;
        r.loading = false;
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (ok) {
      re.tries = 0;
      if (r.act.id === id && r.act.message === ROUTINES_TEXT.actUnknown) r.act.message = ROUTINES_TEXT.actUnknownReloaded;
      render();
      if (r.openId === id) void loadRoutineRuns(id);
      return;
    }
    if (re.tries >= ROUTINE_RELOAD_TRIES || !state.open || state.tab !== "routinen") {
      re.tries = 0;
      return;
    }
    re.timer = later(() => {
      re.timer = null;
      if (!state.open || state.tab !== "routinen") {
        re.tries = 0;
        return;
      }
      void reloadAfterUnknown(id);
    }, ROUTINE_RELOAD_MS);
  }

  /** Knöpfe und Dialog in der Detailansicht */
  function routineActions(r) {
    const a = state.routines.act;
    const actions = Array.isArray(r.actions) ? r.actions.filter(x => x === "run" || x === "pause" || x === "resume") : [];
    const mine = a.id === r.id;
    const nodes = [];
    const button = (key, text, handler, strong, disabled) => {
      const b = h("button", { type: "button", className: strong ? "quiet-button action-confirm" : "quiet-button", "data-focus-key": key, disabled, text });
      b.addEventListener("click", handler);
      return b;
    };
    if (mine && (a.step === "confirm" || (a.step === "busy" && a.action !== "run"))) {
      const busy = a.step === "busy";
      nodes.push(h("div", { className: "settings-routine-confirm", role: "group", "aria-label": ROUTINES_TEXT.actions[a.action] }, [
        h("p", { className: "actions-question", text: ROUTINES_TEXT.confirmQuestion[a.action](String(r.name)) }),
        h("p", { className: "actions-hint", text: ROUTINES_TEXT.confirmExplain[a.action] }),
        h("div", { className: "settings-actions" }, [
          button("routine-act-yes", busy ? ROUTINES_TEXT.actBusy : ROUTINES_TEXT.confirmYes[a.action], () => void runRoutineAction(r.id, a.action), true, busy),
          button("routine-act-no", "Abbrechen", cancelRoutineAction, false, busy),
        ]),
      ]));
    } else if (actions.length) {
      const busy = mine && a.step === "busy";
      nodes.push(h("div", { className: "settings-actions settings-routine-buttons" }, actions.map(x =>
        button("routine-act-" + x, busy && a.action === x ? ROUTINES_TEXT.actBusy : ROUTINES_TEXT.actions[x], () => askRoutineAction(r.id, x), false, a.step === "busy")
      )));
    }
    if (mine && a.message && a.step === "idle") {
      nodes.push(h("p", { className: a.failed ? "actions-error" : "settings-status", role: a.failed ? "alert" : "status", text: a.message }));
    }
    return nodes;
  }

  function toggleRoutine(id) {
    const r = state.routines;
    if (r.act.step !== "busy") Object.assign(r.act, { id: null, action: null, step: "idle", message: null, failed: false });
    if (r.openId === id) {
      r.openId = null;
      r.runs.seq++;
      render();
      return;
    }
    r.openId = id;
    void loadRoutineRuns(id);
  }

  /** Nächste Abfrage nach dem Neustart; nur solange der Reiter „Status" offen ist */
  function scheduleStatusPoll() {
    const flow = state.restartFlow;
    stopStatusPoll();
    if (flow.step !== "waiting" || !state.open || state.tab !== "status") return;
    const elapsed = now() - flow.since;
    if (elapsed >= STATUS_POLL_MAX_MS) {
      flow.step = "timeout";
      flow.message = SETTINGS_TEXT.restartTimeout;
      render();
      return;
    }
    flow.timer = later(async () => {
      flow.timer = null;
      if (flow.step !== "waiting" || !state.open || state.tab !== "status") return;
      await loadStatus();
      scheduleStatusPoll();
    }, elapsed < STATUS_POLL_FAST_FOR_MS ? STATUS_POLL_MS : STATUS_POLL_SLOW_MS);
  }

  function askRestart() {
    const flow = state.restartFlow;
    if (flow.step === "busy" || flow.step === "waiting") return;
    flow.step = "confirm";
    flow.message = null;
    render();
    // Fokus auf „Abbrechen": ein zweites Enter startet nicht aus Versehen neu
    focusKey("status-restart-no");
  }

  function cancelRestart() {
    const flow = state.restartFlow;
    if (flow.step !== "confirm") return;
    flow.step = "idle";
    render();
    focusKey("status-restart");
  }

  /** Erst nach der Rückfrage: POST /api/restart, genau einmal */
  async function confirmRestart() {
    const flow = state.restartFlow;
    if (flow.step !== "confirm") return;
    flow.step = "busy";
    flow.message = null;
    render();
    try {
      const { status, data } = await deps.api("POST", "/api/restart");
      if (status === 202) {
        flow.step = "waiting";
        flow.message = data && typeof data.message === "string" && data.message ? data.message : null;
        flow.startedAt = state.status.data && state.status.data.startedAt ? state.status.data.startedAt : null;
        flow.lost = false;
        flow.since = now();
        render();
        scheduleStatusPoll();
        return;
      }
      flow.step = "failed";
      flow.message = errorText(data, "Neustart konnte nicht angefordert werden (Fehler " + status + ").");
    } catch {
      flow.step = "failed";
      flow.message = SETTINGS_TEXT.restartOffline;
    }
    render();
  }

  function isDirty(name) {
    const f = state.forms.get(name);
    if (!f) return false;
    const result = agentSettingsPatch(f, ownEntry(name));
    return !!result.error || !!result.patch;
  }

  async function save(name) {
    const f = form(name);
    if (f.saving) return;
    const result = agentSettingsPatch(f, ownEntry(name));
    if (result.error) {
      f.error = result.error;
      render();
      return;
    }
    if (!result.patch) return;
    f.saving = true;
    f.error = null;
    clearSaved(f);
    render();
    const agents = {};
    agents[name] = result.patch;
    const attempt = ++state.sync.next;
    let error = null;
    try {
      const { ok, data, status } = await deps.api("PATCH", "/api/settings", { agents });
      if (ok && data && typeof data === "object" && data.settings) {
        // Die übrigen Agenten gleichen sich feldweise ab, der gespeicherte übernimmt alles.
        // Ist die Antwort schon überholt, enthält der übernommene neuere Stand diese
        // Speicherung bereits (der Server vergibt die Versionen der Reihe nach).
        adoptIfNewer(data, attempt);
        resetForm(name);
        const next = form(name);
        next.saved = true;
        next.savedTimer = later(() => {
          next.saved = false;
          next.savedTimer = null;
          render();
        }, SAVED_MS);
        next.restart = data.restartRequired === true ? { status: "idle", message: null } : null;
        render();
        return;
      }
      error = errorText(data, "Speichern fehlgeschlagen (Fehler " + status + ").");
      // Datei inzwischen ungültig: oben dauerhaft anzeigen
      if (status === 409 && state.data) state.data = Object.assign({}, state.data, { fileInvalid: true });
    } catch {
      error = SETTINGS_TEXT.offline;
    }
    // Eingaben bleiben stehen, damit man es erneut versuchen kann
    f.saving = false;
    f.error = error;
    render();
  }

  function clearSaved(f) {
    if (f.savedTimer) cancel(f.savedTimer);
    f.savedTimer = null;
    f.saved = false;
  }

  /** Neustart nur auf Klick (Entscheidung A): POST /api/restart; f ist Agent- oder Abschnittsformular */
  async function restart(f) {
    if (!f.restart || f.restart.status === "busy") return;
    f.restart = { status: "busy", message: null };
    render();
    try {
      const { status, data } = await deps.api("POST", "/api/restart");
      if (status === 202) {
        f.restart = { status: "done", message: (data && data.message) || "Neustart angefordert." };
      } else {
        f.restart = { status: "failed", message: errorText(data, "Neustart konnte nicht angefordert werden (Fehler " + status + ").") };
      }
    } catch {
      f.restart = { status: "failed", message: "Server nicht erreichbar, kein Neustart angefordert." };
    }
    render();
  }

  // --- Reiter „Schlüssel" (Issue #63) -------------------------------------------

  function keyList() {
    const d = state.keys.data;
    return d && Array.isArray(d.keys) ? d.keys.filter(k => k && typeof k.name === "string") : [];
  }

  function findKey(name) {
    return keyList().find(k => k.name === name) || null;
  }

  /** Schreiben nur mit Opt-in (editAllowed) und für änderbare, nicht gesperrte Namen */
  function canEditKey(k) {
    const d = state.keys.data;
    return !!(d && d.editAllowed === true && k && k.editable === true && k.locked !== true);
  }

  /** Passwortfeld leeren und verwerfen; ein späteres Ergebnis findet es nicht mehr */
  function closeKeyEditor(name) {
    const ed = state.keys.editors.get(name);
    if (!ed) return;
    ed.input.value = "";
    state.keys.editors.delete(name);
  }

  /** Beim Verlassen des Reiters oder der Einstellungen: keine Werte zurücklassen */
  function closeAllKeyEditors() {
    for (const name of [...state.keys.editors.keys()]) closeKeyEditor(name);
    if (state.keys.removing === null) state.keys.confirm = null;
  }

  async function loadKeys() {
    const k = state.keys;
    const seq = ++k.seq;
    k.loadSeq = seq;
    // Nur Abgleiche, die vor dieser Anfrage fällig waren, erledigt ihre Antwort
    const reconciling = [...k.reconcile];
    if (k.phase !== "ok") k.phase = "loading";
    k.loading = true;
    render();
    let data = null;
    let error = null;
    try {
      const res = await deps.api("GET", "/api/keys");
      if (res.ok && res.data && typeof res.data === "object" && Array.isArray(res.data.keys)) data = res.data;
      else error = errorText(res.data, KEYS_TEXT.loadFailed);
    } catch {
      error = KEYS_TEXT.loadFailed;
    }
    if (seq !== k.seq) {
      // Von einem Schreibvorgang überholt, kein neueres Laden unterwegs:
      // ein ausstehender Abgleich darf nicht verloren gehen
      if (seq === k.loadSeq && k.reconcile.size > 0) void loadKeys();
      return;
    }
    k.loading = false;
    if (data) {
      for (const name of reconciling) k.reconcile.delete(name);
      k.data = data;
      k.phase = "ok";
      k.error = null;
      // Opt-in entzogen oder Variable nicht mehr änderbar: offene Felder schließen
      for (const name of [...k.editors.keys()]) if (!canEditKey(findKey(name))) closeKeyEditor(name);
      if (k.confirm && !canEditKey(findKey(k.confirm))) k.confirm = null;
      // .env weicht vom laufenden Prozess ab: Neustart anbieten, auch nach Neuladen
      if (!k.restart && keyList().some(x => x.restartPending === true)) k.restart = { status: "idle", message: null };
    } else {
      k.phase = k.data ? "ok" : "failed";
      k.error = error;
    }
    render();
  }

  /** Hinweis, warum nicht geändert werden darf: Tunnel (Issue #99) oder fehlendes Opt-in */
  function keysReadOnlyText(data) {
    return data && data.readOnlyReason === "tunnel" ? KEYS_TEXT.homeOnly : KEYS_TEXT.readOnly;
  }

  /** HTTP 403: Opt-in weg (editAllowed false), über den Tunnel oder gesperrt; Schreibknöpfe sofort weg */
  function keyForbidden(name, data) {
    const k = state.keys;
    if (data && data.editAllowed === false && k.data) {
      k.data = Object.assign({}, k.data, { editAllowed: false }, data.homeOnly === true ? { readOnlyReason: "tunnel" } : {});
      closeAllKeyEditors();
    } else if (data && data.locked === true && k.data) {
      k.data = Object.assign({}, k.data, {
        keys: keyList().map(x => (x.name === name ? Object.assign({}, x, { editable: false, locked: true }) : x)),
      });
      closeKeyEditor(name);
    }
    k.rows.set(name, { kind: "error", text: errorText(data, keysReadOnlyText(k.data)) });
    void loadKeys();
  }

  /**
   * Nach Setzen oder Entfernen: Zeile anpassen, Neustart anbieten.
   * Ein Erfolg gilt, solange kein später gestarteter Schreibvorgang schon
   * erfolgreich übernommen wurde; gescheiterte spätere Versuche zählen nicht.
   * Den Stand nach überlappenden Schreibvorgängen gleicht keyWriteDone ab.
   */
  function keyChanged(name, write, data, text) {
    const k = state.keys;
    if (write <= (k.applied.get(name) || 0)) return;
    k.applied.set(name, write);
    k.seq++; // Eine vorher gestartete Liste ist überholt
    k.loading = false;
    if (k.data) {
      k.data = Object.assign({}, k.data, {
        keys: keyList().map(x => (x.name === name
          ? Object.assign({}, x, { set: data.set === true, last4: typeof data.last4 === "string" ? data.last4 : null, restartPending: true })
          : x)),
      });
    }
    k.rows.set(name, { kind: "ok", text: typeof data.message === "string" && data.message ? data.message : text });
    if (!k.restart || k.restart.status !== "busy") k.restart = { status: "idle", message: null };
  }

  /** Nummeriert Schreibvorgänge je Name in Startreihenfolge und zählt laufende mit */
  function nextKeyWrite(name) {
    const k = state.keys;
    const n = (k.writes.get(name) || 0) + 1;
    k.writes.set(name, n);
    const running = k.pending.get(name) || 0;
    if (running > 0) k.overlapped.add(name);
    k.pending.set(name, running + 1);
    return n;
  }

  /**
   * Schreibvorgang beendet. Haben sich mehrere für denselben Namen
   * überschnitten, sagt die Startreihenfolge nichts über die Reihenfolge in
   * der .env: nach dem letzten die Liste vom Server holen. Der Abgleich
   * steht aus, bis eine Liste übernommen ist. Offene Felder bleiben dabei,
   * wie sie sind.
   */
  function keyWriteDone(name) {
    const k = state.keys;
    const running = (k.pending.get(name) || 1) - 1;
    if (running > 0) {
      k.pending.set(name, running);
      return;
    }
    k.pending.delete(name);
    if (k.overlapped.delete(name)) {
      k.reconcile.add(name);
      void loadKeys();
    }
  }

  function openKeyEditor(name) {
    const k = state.keys;
    const key = findKey(name);
    if (!canEditKey(key) || k.editors.has(name)) return;
    k.confirm = null;
    k.rows.delete(name);
    const input = document.createElement("input");
    // Verdeckt, nie vorausgefüllt; new-password hält den Passwortmanager vom WebUI-Passwort fern
    input.setAttribute("type", "password");
    input.type = "password";
    input.className = "settings-input";
    input.id = "settings-key-input-" + name;
    input.setAttribute("id", input.id);
    input.setAttribute("autocomplete", "new-password");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("data-focus-key", "key-input:" + name);
    input.setAttribute("aria-label", "Neuer Wert für " + name);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        void submitKey(name);
      } else if (event.key === "Escape") cancelKeyEditor(name);
    });
    k.editors.set(name, { mode: key.set ? "replace" : "set", input, busy: false, error: null });
    render();
    focusKey("key-input:" + name);
  }

  function cancelKeyEditor(name) {
    const ed = state.keys.editors.get(name);
    if (!ed || ed.busy) return;
    closeKeyEditor(name);
    render();
    focusKey("key-edit:" + name);
  }

  async function submitKey(name) {
    const k = state.keys;
    const ed = k.editors.get(name);
    if (!ed || ed.busy) return;
    if (!canEditKey(findKey(name))) {
      closeKeyEditor(name);
      render();
      return;
    }
    // Der Wert lebt nur in dieser Funktion und geht nur in den Body von PUT
    const value = ed.input.value;
    if (value.trim() === "") {
      ed.error = KEYS_TEXT.empty;
      render();
      focusKey("key-input:" + name);
      return;
    }
    ed.busy = true;
    ed.error = null;
    ed.input.disabled = true;
    k.rows.delete(name);
    const write = nextKeyWrite(name);
    render();
    let res = null;
    let offline = false;
    try {
      res = await deps.api("PUT", "/api/keys/" + encodeURIComponent(name), { value });
    } catch {
      offline = true;
    }
    putKeyResult(name, ed, write, value, res, offline);
    keyWriteDone(name);
  }

  function putKeyResult(name, ed, write, value, res, offline) {
    const k = state.keys;
    // Inzwischen geschlossen (Reiter verlassen): Feld ist schon leer, nichts zurückholen.
    // Erfolg und 403 gelten trotzdem, sonst zeigt die Liste einen alten Stand ohne
    // Neustart-Hinweis oder bietet nach entzogenem Opt-in weiter Schreibknöpfe an.
    if (k.editors.get(name) !== ed) {
      if (!offline && res.status === 200 && res.data && typeof res.data === "object") {
        keyChanged(name, write, res.data, KEYS_TEXT.saved);
        render();
      } else if (!offline && res.status === 403) {
        keyForbidden(name, res.data);
        render();
      }
      return;
    }
    ed.busy = false;
    ed.input.disabled = false;
    if (!offline && res.status === 200 && res.data && typeof res.data === "object") {
      closeKeyEditor(name);
      keyChanged(name, write, res.data, KEYS_TEXT.saved);
      render();
      focusKey("key-edit:" + name);
      return;
    }
    if (!offline && res.status === 403) {
      keyForbidden(name, res.data);
      render();
      return;
    }
    let text = offline ? KEYS_TEXT.offline : errorText(res.data, "Speichern fehlgeschlagen (Fehler " + res.status + ").");
    // Eine Meldung, die den Wert enthielte, wird nie angezeigt
    const trimmed = value.trim();
    if (trimmed.length >= 4 && text.includes(trimmed)) text = "Speichern fehlgeschlagen (Fehler " + (res ? res.status : "Netz") + ").";
    // Der Wert bleibt nur im Feld, damit man es erneut versuchen kann
    ed.error = text;
    render();
    focusKey("key-input:" + name);
  }

  function askRemoveKey(name) {
    const k = state.keys;
    if (!canEditKey(findKey(name)) || k.removing) return;
    closeKeyEditor(name);
    k.rows.delete(name);
    k.confirm = name;
    render();
    // Fokus auf „Abbrechen": ein zweites Enter löscht nicht aus Versehen
    focusKey("key-remove-no:" + name);
  }

  function cancelRemoveKey(name) {
    const k = state.keys;
    if (k.confirm !== name || k.removing === name) return;
    k.confirm = null;
    render();
    focusKey("key-remove:" + name);
  }

  /** Erst nach der Rückfrage: DELETE /api/keys/<name>, genau einmal */
  async function confirmRemoveKey(name) {
    const k = state.keys;
    if (k.confirm !== name || k.removing) return;
    if (!canEditKey(findKey(name))) {
      k.confirm = null;
      render();
      return;
    }
    k.removing = name;
    const write = nextKeyWrite(name);
    render();
    let res = null;
    try {
      res = await deps.api("DELETE", "/api/keys/" + encodeURIComponent(name));
    } catch {
      // unten als offline gemeldet
    }
    k.removing = null;
    k.confirm = null;
    if (res && res.status === 200 && res.data && typeof res.data === "object") {
      keyChanged(name, write, res.data, KEYS_TEXT.removed);
    } else if (res && res.status === 403) {
      keyForbidden(name, res.data);
    } else {
      k.rows.set(name, { kind: "error", text: res ? errorText(res.data, "Entfernen fehlgeschlagen (Fehler " + res.status + ").") : KEYS_TEXT.offline });
      if (res && res.status === 404) void loadKeys();
    }
    keyWriteDone(name);
    render();
    focusKey("key-edit:" + name);
  }

  // --- Anweisungen ------------------------------------------------------------

  function instructionsPath(name, last) {
    return "/api/agents/" + encodeURIComponent(name) + "/instructions" + (last ? "/last" : "");
  }

  function inst(name) {
    if (!state.instructions.has(name)) {
      state.instructions.set(name, { status: "idle", list: [], digest: null, revision: null, error: null, text: "", busy: false, confirm: false, seq: 0 });
    }
    return state.instructions.get(name);
  }

  /**
   * Liste aus einer Serverantwort übernehmen, wenn sie nicht älter ist als die
   * angezeigte (revision vom Server, wie bei /api/settings). Gleich ob GET,
   * Schreibantwort oder 409: eine verspätete ältere Liste ersetzt nie eine
   * neuere (Codex-Befund Runde 4 zu PR #43, auch bei /agent aus Telegram
   * dazwischen). false, wenn verworfen.
   */
  function adoptList(i, data) {
    if (!data || !Array.isArray(data.instructions)) return false;
    if (!isNotOlder(i.revision, data.revision)) return false;
    i.list = data.instructions.map(String);
    i.digest = typeof data.digest === "string" ? data.digest : null;
    if (data.revision && typeof data.revision.seq === "number") i.revision = data.revision;
    i.status = "ok";
    return true;
  }

  /**
   * Lädt die Liste vom Server; der ungesendete Text im Feld bleibt stehen.
   * i.seq: nur die Antwort des letzten Ladens zählt als Ergebnis des Ladens,
   * etwa nach erneutem Öffnen; welche Liste neuer ist, entscheidet revision.
   */
  async function loadInstructions(name) {
    const i = inst(name);
    const seq = ++i.seq;
    // Bis die neue Liste da ist, keine Löschknöpfe auf der alten
    i.status = "loading";
    i.error = null;
    render();
    try {
      const { ok, data } = await deps.api("GET", instructionsPath(name, false));
      if (seq !== i.seq) return;
      if (ok && data && Array.isArray(data.instructions)) {
        // Älter als eine inzwischen übernommene Schreibantwort: die bleibt stehen
        adoptList(i, data);
        i.status = "ok";
      } else {
        i.status = "failed";
        i.error = errorText(data, "Anweisungen konnten nicht geladen werden.");
      }
    } catch {
      if (seq !== i.seq) return;
      i.status = "failed";
      i.error = "Server nicht erreichbar, Anweisungen nicht geladen.";
    }
    render();
  }

  /**
   * POST, DELETE .../last oder DELETE; bei Erfolg kommt die neue Liste zurück.
   * Beide DELETE senden den Prüfwert der angezeigten Liste mit (expected, vom
   * Server als digest geliefert, gleich lang für jede Liste): Hat sie sich auf
   * dem Server inzwischen geändert, entfernt er nichts und antwortet 409 mit
   * der aktuellen Liste, die dann angezeigt wird.
   */
  async function changeInstructions(name, method, last, body) {
    const i = inst(name);
    if (i.busy) return false;
    i.busy = true;
    i.error = null;
    render();
    let done = false;
    try {
      const { ok, data, status } = await deps.api(method, instructionsPath(name, last), body);
      if (ok && data && Array.isArray(data.instructions)) {
        adoptList(i, data);
        done = true;
      } else {
        if (status === 409) {
          adoptList(i, data);
          // Eine offene Rückfrage nannte eine veraltete Anzahl
          i.confirm = false;
        }
        i.error = errorText(data, "Anweisungen nicht gespeichert (Fehler " + status + ").");
      }
    } catch {
      i.error = SETTINGS_TEXT.offline;
    }
    i.busy = false;
    return done;
  }

  async function addInstruction(name) {
    const i = inst(name);
    const text = normalizeInstructionText(i.text);
    if (text === null) {
      i.error = SETTINGS_TEXT.instructionInvalid;
      render();
      return;
    }
    // Der Text bleibt im Feld, bis der Server bestätigt
    if (await changeInstructions(name, "POST", false, { text })) i.text = "";
    render();
    if (!i.error) focusKey("inst-text:" + name);
  }

  async function removeLast(name) {
    await changeInstructions(name, "DELETE", true, { expected: inst(name).digest });
    render();
  }

  async function clearAll(name) {
    const i = inst(name);
    if (await changeInstructions(name, "DELETE", false, { expected: i.digest })) i.confirm = false;
    render();
    if (!i.confirm) focusKey("inst-clear:" + name);
  }

  // --- Agenten verwalten (Issue #51) -------------------------------------------

  function agentPath(name, action) {
    return "/api/agents/" + encodeURIComponent(name) + (action ? "/" + action : "");
  }

  /**
   * Katalog übernehmen, wenn er nicht älter ist als der angezeigte. Zustand
   * von Agenten, die es nicht mehr gibt, fällt weg. app.js erfährt davon
   * (Seitenleiste, Agenten-Chip, Auswahl für neue Gespräche und Topic-Zuordnung);
   * topicsChanged: Topics wurden umgestellt, die Gesprächsliste neu holen.
   * false, wenn verworfen.
   */
  function adoptCatalog(data, topicsChanged) {
    const c = state.catalog;
    if (!data || typeof data !== "object" || !Array.isArray(data.agents)) return false;
    if (!isNotOlder(c.revision, data.revision)) {
      if (topicsChanged && typeof deps.onAgentsChanged === "function") deps.onAgentsChanged(null, { topicsChanged: true });
      return false;
    }
    c.data = data;
    if (data.revision && typeof data.revision.seq === "number") c.revision = data.revision;
    c.status = "ok";
    c.error = null;
    const active = new Set(agentNames());
    for (const map of [state.prompts, state.boards, state.removals, state.forms, state.instructions]) {
      for (const name of [...map.keys()]) if (!active.has(name)) map.delete(name);
    }
    for (const name of [...state.expanded]) if (!active.has(name)) state.expanded.delete(name);
    if (typeof deps.onAgentsChanged === "function") deps.onAgentsChanged(data, { topicsChanged: !!topicsChanged });
    return true;
  }

  async function loadCatalog() {
    const c = state.catalog;
    const seq = ++c.seq;
    if (!c.data) c.status = "loading";
    render();
    let error = null;
    try {
      const { ok, data } = await deps.api("GET", "/api/agents");
      if (ok && data && Array.isArray(data.agents)) adoptCatalog(data);
      else error = errorText(data, AGENT_TEXT.catalogFailed);
    } catch {
      error = AGENT_TEXT.catalogFailed;
    }
    if (error && seq === c.seq) {
      c.error = error;
      if (!c.data) c.status = "failed";
    }
    render();
  }

  // System-Prompt

  function promptState(name) {
    if (!state.prompts.has(name)) {
      state.prompts.set(name, {
        status: "idle", data: null, revision: null, seq: 0, error: null,
        editing: false, draft: "", busy: false, saveError: null, confirmReset: false, saved: false, savedTimer: null,
      });
    }
    return state.prompts.get(name);
  }

  /** Prompt aus einer Serverantwort, wenn nicht älter als der angezeigte; der Entwurf bleibt unberührt */
  function adoptPrompt(p, data) {
    if (!data || typeof data.systemPrompt !== "string") return false;
    if (!isNotOlder(p.revision, data.revision)) return false;
    p.data = {
      systemPrompt: data.systemPrompt,
      codePrompt: typeof data.codePrompt === "string" ? data.codePrompt : null,
      promptSource: data.promptSource === "custom" ? "custom" : "code",
    };
    if (data.revision && typeof data.revision.seq === "number") p.revision = data.revision;
    p.status = "ok";
    p.error = null;
    return true;
  }

  async function loadPrompt(name) {
    const p = promptState(name);
    const seq = ++p.seq;
    if (!p.data) p.status = "loading";
    p.error = null;
    render();
    try {
      const { ok, data } = await deps.api("GET", agentPath(name, "prompt"));
      if (seq !== p.seq) return;
      if (ok && data && typeof data.systemPrompt === "string") adoptPrompt(p, data);
      else {
        p.error = errorText(data, AGENT_TEXT.promptFailed);
        if (!p.data) p.status = "failed";
      }
    } catch {
      if (seq !== p.seq) return;
      p.error = AGENT_TEXT.promptFailed;
      if (!p.data) p.status = "failed";
    }
    render();
  }

  function startPromptEdit(name) {
    const p = promptState(name);
    if (!p.data || p.editing) return;
    p.editing = true;
    p.draft = p.data.systemPrompt;
    p.saveError = null;
    p.confirmReset = false;
    clearSaved(p);
    render();
    focusKey("prompt-text:" + name);
  }

  function cancelPromptEdit(name) {
    const p = promptState(name);
    if (p.busy) return;
    p.editing = false;
    p.draft = "";
    p.saveError = null;
    render();
    focusKey("prompt-edit:" + name);
  }

  function markSaved(p) {
    clearSaved(p);
    p.saved = true;
    p.savedTimer = later(() => {
      p.saved = false;
      p.savedTimer = null;
      render();
    }, SAVED_MS);
  }

  /** PUT oder DELETE auf .../prompt; bei Fehlern bleibt der Entwurf stehen */
  async function writePrompt(name, method, body) {
    const p = promptState(name);
    if (p.busy) return false;
    p.busy = true;
    p.saveError = null;
    render();
    let done = false;
    try {
      const { ok, data, status } = await deps.api(method, agentPath(name, "prompt"), body);
      if (ok && data && typeof data.systemPrompt === "string") {
        adoptPrompt(p, data);
        done = true;
      } else {
        p.saveError = errorText(data, "System-Prompt nicht gespeichert (Fehler " + status + ").");
      }
    } catch {
      p.saveError = SETTINGS_TEXT.offline;
    }
    p.busy = false;
    if (done) {
      markSaved(p);
      // Kennzeichnung in der Liste (promptSource) nachziehen
      void loadCatalog();
    }
    return done;
  }

  async function savePrompt(name) {
    const p = promptState(name);
    const checked = normalizePromptText(p.draft);
    if (checked.error) {
      p.saveError = checked.error;
      render();
      focusKey("prompt-text:" + name);
      return;
    }
    if (await writePrompt(name, "PUT", { text: checked.value })) {
      p.editing = false;
      p.draft = "";
    }
    render();
    focusKey(p.editing ? "prompt-save:" + name : "prompt-edit:" + name);
  }

  async function resetPrompt(name) {
    const p = promptState(name);
    if (await writePrompt(name, "DELETE")) p.confirmReset = false;
    render();
    if (!p.confirmReset) focusKey("prompt-edit:" + name);
  }

  // Board-Schalter

  function boardState(name) {
    if (!state.boards.has(name)) state.boards.set(name, { busy: false, pending: null, error: null, saved: false, savedTimer: null });
    return state.boards.get(name);
  }

  async function setBoard(name, on) {
    const b = boardState(name);
    const entry = catalogEntry(name);
    if (b.busy || !entry || entry.board === on) return;
    b.busy = true;
    b.pending = on;
    b.error = null;
    clearSaved(b);
    render();
    try {
      const { ok, data, status } = await deps.api("PATCH", agentPath(name), { board: on });
      if (ok && data && Array.isArray(data.agents)) {
        adoptCatalog(data);
        markSaved(b);
      } else {
        b.error = errorText(data, "Board-Schalter nicht gespeichert (Fehler " + status + ").");
      }
    } catch {
      b.error = SETTINGS_TEXT.offline;
    }
    b.busy = false;
    b.pending = null;
    render();
    focusKey("board:" + name + ":" + (catalogEntry(name) && catalogEntry(name).board ? "on" : "off"));
  }

  // Löschen

  function removalState(name) {
    if (!state.removals.has(name)) state.removals.set(name, { step: "idle", topics: [], error: null, input: "", seq: 0 });
    return state.removals.get(name);
  }

  /** „Agent löschen …": erst die betroffenen Topics holen, ohne sie keine Rückfrage */
  async function askDelete(name) {
    const r = removalState(name);
    if (r.step === "busy" || name === GENERAL_AGENT) return;
    const seq = ++r.seq;
    r.step = "loading";
    r.error = null;
    r.input = "";
    render();
    let topics = null;
    let error = null;
    try {
      const { ok, data } = await deps.api("GET", agentPath(name, "usage"));
      if (ok && data && Array.isArray(data.topics)) {
        topics = data.topics.filter(t => t && typeof t.chatId === "string" && Number.isInteger(t.topicId));
      } else error = errorText(data, AGENT_TEXT.usageFailed);
    } catch {
      error = AGENT_TEXT.usageFailed;
    }
    if (seq !== r.seq || r.step !== "loading") return;
    if (topics) {
      r.topics = topics;
      r.step = "confirm";
    } else {
      r.step = "failed";
      r.error = error;
    }
    render();
    focusKey(topics ? "delete-input:" + name : "delete-retry:" + name);
  }

  function cancelDelete(name) {
    const r = removalState(name);
    if (r.step === "busy") return;
    r.seq++;
    r.step = "idle";
    r.error = null;
    r.input = "";
    render();
    focusKey("delete:" + name);
  }

  /**
   * DELETE mit der eingetippten Kennung. Auch ein Teilerfolg (HTTP 500 mit
   * removed, Topics nicht umgestellt) hat den Agenten gelöscht: Der neue
   * Bestand wird übernommen und die Warnung des Servers gezeigt, ohne
   * erneuten Versuch.
   */
  async function confirmDelete(name) {
    const r = removalState(name);
    if (r.step !== "confirm" || r.input !== name) return;
    const label = labelOf(name);
    r.step = "busy";
    r.error = null;
    render();
    try {
      const { data, status } = await deps.api("DELETE", agentPath(name), { confirm: name });
      if (data && data.removed === name) {
        const moved = Array.isArray(data.moved) ? data.moved.length : 0;
        if (!adoptCatalog(data, true)) void loadCatalog();
        state.removals.delete(name);
        state.expanded.delete(name);
        state.agentNotice = data.topicsMoved === false
          ? { kind: "warn", text: errorText(data, "Agent gelöscht, Topics nicht umgestellt.") }
          : { kind: "ok", text: "„" + label + "“ gelöscht." + (moved ? " " + (moved === 1 ? "Ein Topic nutzt" : moved + " Topics nutzen") + " jetzt General." : "") };
        void load();
        render();
        focusKey("agent-notice");
        return;
      }
      r.step = "confirm";
      r.error = errorText(data, "Löschen fehlgeschlagen (Fehler " + status + ").");
      // Agent gibt es nicht mehr: Liste nachladen
      if (status === 404) void loadCatalog();
    } catch {
      r.step = "confirm";
      r.error = SETTINGS_TEXT.offline;
    }
    render();
  }

  // Wiederherstellen

  async function restoreAgent(name) {
    if (state.restoring) return;
    state.restoring = name;
    state.restoreError = null;
    render();
    try {
      const { ok, data, status } = await deps.api("POST", agentPath(name, "restore"));
      if (ok && data && Array.isArray(data.agents)) {
        if (!adoptCatalog(data)) void loadCatalog();
        state.agentNotice = { kind: "ok", text: "„" + labelOf(name) + "“ ist wieder da, mit dem Standard-Prompt." };
        void load();
      } else {
        state.restoreError = { name, text: errorText(data, "Wiederherstellen fehlgeschlagen (Fehler " + status + ").") };
        if (status === 404 || status === 409) void loadCatalog();
      }
    } catch {
      state.restoreError = { name, text: SETTINGS_TEXT.offline };
    }
    state.restoring = null;
    render();
    focusKey(state.restoreError ? "restore:" + name : "agent-notice");
  }

  // Neuer Agent

  function openCreate() {
    state.creating = {
      name: "", description: "", prompt: "", model: MODEL_DEFAULT, custom: "", effort: EFFORT_DEFAULT,
      busy: false, errors: {},
    };
    state.agentNotice = null;
    render();
    focusKey("create-name");
  }

  function closeCreate() {
    if (!state.creating || state.creating.busy) return;
    state.creating = null;
    render();
    focusKey("create-open");
  }

  /** Feldfehler vor dem Senden; leeres Objekt, wenn alles passt */
  function createErrors(f) {
    const errors = {};
    if (!AGENT_ID.test(f.name)) errors.name = AGENT_TEXT.nameInvalid;
    if (normalizeDescriptionText(f.description) === null) errors.description = AGENT_TEXT.descriptionInvalid;
    const prompt = normalizePromptText(f.prompt);
    if (prompt.error) errors.prompt = prompt.error;
    if (f.model === MODEL_CUSTOM) {
      if (!String(f.custom || "").trim()) errors.model = SETTINGS_TEXT.customMissing;
      else if (normalizeModelName(f.custom) === null) errors.model = SETTINGS_TEXT.customInvalid;
    }
    return errors;
  }

  async function submitCreate() {
    const f = state.creating;
    if (!f || f.busy) return;
    f.errors = createErrors(f);
    const first = ["name", "description", "prompt", "model"].find(k => f.errors[k]);
    if (first) {
      render();
      focusKey("create-" + first);
      return;
    }
    const body = {
      name: f.name,
      description: normalizeDescriptionText(f.description),
      systemPrompt: normalizePromptText(f.prompt).value,
    };
    if (f.model === MODEL_CUSTOM) body.model = normalizeModelName(f.custom);
    else if (f.model !== MODEL_DEFAULT) body.model = f.model;
    if (f.effort !== EFFORT_DEFAULT) body.effort = f.effort;
    f.busy = true;
    render();
    try {
      const { data, status } = await deps.api("POST", "/api/agents", body);
      if (status === 201 && data && data.created === f.name) {
        const name = f.name;
        if (!adoptCatalog(data)) void loadCatalog();
        state.creating = null;
        state.agentNotice = data.settingsSaved === false
          ? { kind: "warn", text: "„" + labelOf(name) + "“ angelegt. " + errorText({ error: data.warning }, "Modell und Effort nicht gespeichert.") }
          : { kind: "ok", text: "„" + labelOf(name) + "“ angelegt. Er steht jetzt bei „Neues Gespräch“ und in der Topic-Zuordnung zur Wahl." };
        state.expanded.add(name);
        void loadPrompt(name);
        void loadInstructions(name);
        void load();
        render();
        focusKey("agent-notice");
        return;
      }
      const text = errorText(data, "Anlegen fehlgeschlagen (Fehler " + status + ").");
      const field = createErrorField(status, text);
      f.errors = field ? { [field]: text } : { form: text };
      f.busy = false;
      render();
      focusKey(field ? "create-" + field : "create-submit");
      return;
    } catch {
      f.errors = { form: SETTINGS_TEXT.offline };
    }
    f.busy = false;
    render();
  }

  // --- Anzeige ----------------------------------------------------------------

  function renderTabs() {
    const fragment = document.createDocumentFragment();
    for (const tab of SETTINGS_TABS) {
      const selected = tab.id === state.tab;
      const button = h("button", {
        type: "button",
        className: "theme-option settings-tab",
        role: "tab",
        id: "settings-tab-" + tab.id,
        "aria-selected": selected ? "true" : "false",
        "aria-controls": "settings-panel",
        tabindex: selected ? "0" : "-1",
        disabled: !tab.ready,
        title: tab.ready ? null : "Kommt im nächsten Schritt",
        "data-focus-key": "tab:" + tab.id,
        text: tab.label,
      });
      if (tab.ready) {
        button.addEventListener("click", () => selectTab(tab.id));
        button.addEventListener("keydown", event => tabKey(event, tab.id));
      }
      fragment.appendChild(button);
    }
    el.tabs.replaceChildren(fragment);
    if (typeof el.panel.setAttribute === "function") el.panel.setAttribute("aria-labelledby", "settings-tab-" + state.tab);
  }

  /** Reiter wechseln: über app.js (Adresse ohne neuen Verlaufseintrag), sonst direkt */
  function selectTab(id) {
    if (typeof deps.onTab === "function") deps.onTab(id);
    else show(id);
  }

  /** Pfeiltasten wechseln den Reiter reihum, Pos1/Ende an den Rand */
  function tabKey(event, id) {
    const ready = SETTINGS_TABS.filter(t => t.ready).map(t => t.id);
    const index = ready.indexOf(id);
    let next = null;
    if (event.key === "ArrowRight") next = ready[(index + 1) % ready.length];
    else if (event.key === "ArrowLeft") next = ready[(index - 1 + ready.length) % ready.length];
    else if (event.key === "Home") next = ready[0];
    else if (event.key === "End") next = ready[ready.length - 1];
    if (!next) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    selectTab(next);
    focusKey("tab:" + next);
  }

  function summary(name) {
    const eff = state.data && state.data.effective && state.data.effective.agents && state.data.effective.agents[name];
    if (!eff) return "";
    const parts = [];
    if (eff.model && eff.model.value) parts.push(String(eff.model.value));
    parts.push("Effort " + (eff.effort && eff.effort.value ? String(eff.effort.value) : "automatisch"));
    return parts.join(" · ");
  }

  function modelField(name, f) {
    const inherited = state.data.inherited && state.data.inherited[name];
    const select = h("select", { id: "settings-model-" + name, className: "settings-input", "data-focus-key": "model:" + name, disabled: f.saving });
    select.appendChild(h("option", { value: MODEL_DEFAULT, text: inheritedLabel(inherited && inherited.model) }));
    for (const model of state.claudeModels) select.appendChild(h("option", { value: model, text: model }));
    select.appendChild(h("option", { value: MODEL_CUSTOM, text: "Eigenes Modell …" }));
    select.value = f.model;
    select.addEventListener("change", () => {
      f.model = select.value;
      f.error = null;
      clearSaved(f);
      render();
      if (f.model === MODEL_CUSTOM) focusKey("custom:" + name);
    });
    const field = h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: "settings-model-" + name, text: "Modell" }),
      h("span", { className: "settings-select" }, [select]),
      // Issue #126: Agenten-Modelle gehen nie an Codex oder OpenCode
      h("p", { className: "actions-hint settings-engine-scope", text: "gilt für Claude Code" }),
    ]);
    if (f.model === MODEL_CUSTOM) {
      const custom = h("input", {
        id: "settings-custom-" + name,
        className: "settings-input",
        type: "text",
        value: f.custom,
        placeholder: "Modell-ID, z.B. claude-sonnet-5",
        "aria-label": "Eigenes Modell für " + deps.agentLabel(name),
        autocomplete: "off",
        spellcheck: "false",
        "data-focus-key": "custom:" + name,
        disabled: f.saving,
      });
      custom.value = f.custom;
      custom.addEventListener("input", () => {
        f.custom = custom.value;
        f.error = null;
        clearSaved(f);
        updateSaveButton(name);
      });
      custom.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        void save(name);
      });
      field.appendChild(custom);
    }
    return field;
  }

  /**
   * „Standard (…)" beim Effort: Der Server rechnet den Wert für das
   * gespeicherte eigene Modell aus (der Standard-Effort hängt vom Modell ab).
   * Weicht das Modell im Formular davon ab, steht dort kein Wert, statt eines
   * falschen.
   */
  function effortDefaultLabel(name, f) {
    if (agentFieldEdits(f, ownEntry(name)).model) return SETTINGS_TEXT.effortByModel;
    const inherited = state.data.inherited && state.data.inherited[name];
    return inheritedLabel(inherited && inherited.effort);
  }

  function effortField(name, f) {
    const levels = Array.isArray(state.data.effortLevels) ? state.data.effortLevels : [];
    const select = h("select", { id: "settings-effort-" + name, className: "settings-input", "data-focus-key": "effort:" + name, disabled: f.saving });
    select.appendChild(h("option", { value: EFFORT_DEFAULT, text: effortDefaultLabel(name, f) }));
    for (const level of levels) select.appendChild(h("option", { value: String(level), text: String(level) }));
    select.value = f.effort;
    select.addEventListener("change", () => {
      f.effort = select.value;
      f.error = null;
      clearSaved(f);
      render();
    });
    return h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: "settings-effort-" + name, text: "Effort" }),
      h("span", { className: "settings-select" }, [select]),
    ]);
  }

  /** Speichern ist nur mit einer Änderung aktiv; beim Tippen ohne Neuzeichnen, dazu „Standard" beim Effort */
  function updateSaveButton(name) {
    if (typeof document.querySelector !== "function") return;
    const button = document.querySelector('[data-focus-key="save:' + name + '"]');
    if (button) button.disabled = form(name).saving || !isDirty(name) || !!(state.data && state.data.fileInvalid);
    const effort = document.querySelector('[data-focus-key="effort:' + name + '"]');
    if (effort && effort.options && effort.options[0]) effort.options[0].textContent = effortDefaultLabel(name, form(name));
  }

  function saveBlock(name, f) {
    return saveControls(name, f, isDirty(name), () => void save(name));
  }

  /** Speichern, „Gespeichert.", Fehler und Neustart-Hinweis; key ergibt save:<key> und restart:<key> */
  function saveControls(name, f, dirty, onSave) {
    const blocked = !!state.data.fileInvalid;
    const button = h("button", {
      type: "button",
      className: "primary-button settings-save",
      "data-focus-key": "save:" + name,
      disabled: f.saving || blocked || !dirty,
      text: f.saving ? "Wird gespeichert …" : "Speichern",
    });
    button.addEventListener("click", onSave);
    const row = h("div", { className: "settings-actions" }, [
      button,
      h("p", { className: "settings-status", role: "status", text: f.saved ? "Gespeichert." : "" }),
    ]);
    const nodes = [row];
    if (f.error) nodes.push(h("p", { className: "actions-error", role: "alert", text: f.error }));
    if (f.restart) {
      const box = h("div", { className: "settings-restart" }, [h("p", { className: "actions-hint", text: SETTINGS_TEXT.restartNote })]);
      if (f.restart.status !== "done") {
        const again = h("button", {
          type: "button",
          className: "quiet-button action-confirm",
          "data-focus-key": "restart:" + name,
          disabled: f.restart.status === "busy",
          text: f.restart.status === "busy" ? "Wird angefordert …" : "Jetzt neu starten",
        });
        again.addEventListener("click", () => void restart(f));
        box.appendChild(again);
      }
      if (f.restart.message) {
        box.appendChild(h("p", {
          className: f.restart.status === "failed" ? "actions-error" : "actions-hint",
          role: f.restart.status === "failed" ? "alert" : "status",
          text: f.restart.message,
        }));
      }
      nodes.push(box);
    }
    return nodes;
  }

  function instructionsBlock(name) {
    const i = inst(name);
    const label = labelOf(name);
    const section = h("section", { className: "settings-section", "aria-labelledby": "settings-inst-title-" + name }, [
      h("h3", { className: "settings-label", id: "settings-inst-title-" + name, text: "Zusätzliche Anweisungen" }),
      h("p", { className: "actions-hint", text: SETTINGS_TEXT.instructionsNote }),
    ]);
    if (i.status === "idle" || i.status === "loading") {
      section.appendChild(h("p", { className: "actions-hint", text: "Lädt …" }));
      return section;
    }
    if (i.status === "failed") {
      section.appendChild(h("p", { className: "actions-error", role: "alert", text: i.error }));
      const retry = h("button", { type: "button", className: "quiet-button", "data-focus-key": "inst-retry:" + name, text: "Erneut laden" });
      retry.addEventListener("click", () => void loadInstructions(name));
      section.appendChild(retry);
      return section;
    }
    if (i.list.length) {
      const list = h("ol", { className: "settings-instructions" });
      for (const line of i.list) list.appendChild(h("li", { text: line }));
      section.appendChild(list);
    } else {
      section.appendChild(h("p", { className: "settings-empty", text: "Keine zusätzlichen Anweisungen." }));
    }

    const inputId = "settings-inst-" + name;
    const textarea = h("textarea", {
      id: inputId,
      className: "settings-input settings-textarea",
      rows: "2",
      placeholder: "z.B. Antworte kürzer",
      "data-focus-key": "inst-text:" + name,
      disabled: i.busy,
    });
    textarea.value = i.text;
    textarea.addEventListener("input", () => {
      i.text = textarea.value;
      if (i.error) {
        i.error = null;
        render();
      }
    });
    section.appendChild(h("label", { className: "settings-label", for: inputId, text: "Neue Anweisung für " + label }));
    section.appendChild(textarea);

    const actions = h("div", { className: "settings-actions settings-inst-actions" });
    const add = (text, key, handler, disabled, strong) => {
      const button = h("button", {
        type: "button",
        className: strong ? "quiet-button action-confirm" : "quiet-button",
        "data-focus-key": key + ":" + name,
        disabled: i.busy || disabled,
        text,
      });
      button.addEventListener("click", handler);
      actions.appendChild(button);
    };
    if (i.confirm) {
      section.appendChild(h("p", {
        className: "actions-question",
        text: (i.list.length === 1 ? "Die Anweisung" : "Alle " + i.list.length + " Anweisungen") + " für " + label + " entfernen?",
      }));
      add(i.busy ? "Wird entfernt …" : "Alle entfernen", "inst-clear-yes", () => void clearAll(name), false, true);
      add("Abbrechen", "inst-clear-no", () => {
        i.confirm = false;
        render();
        focusKey("inst-clear:" + name);
      });
    } else {
      add(i.busy ? "Wird gespeichert …" : "Hinzufügen", "inst-add", () => void addInstruction(name), false, true);
      add("Letzte entfernen", "inst-last", () => void removeLast(name), i.list.length === 0);
      add("Alle entfernen", "inst-clear", () => {
        i.confirm = true;
        i.error = null;
        render();
        // Fokus auf „Abbrechen": ein zweites Enter entfernt nicht aus Versehen
        focusKey("inst-clear-no:" + name);
      }, i.list.length === 0);
    }
    section.appendChild(actions);
    if (i.error) section.appendChild(h("p", { className: "actions-error", role: "alert", text: i.error }));
    return section;
  }

  // --- Anzeige: Agenten verwalten (Issue #51) ------------------------------------

  function quietButton(key, text, handler, options) {
    const o = options || {};
    const button = h("button", {
      type: "button",
      className: o.strong ? "quiet-button action-confirm" : "quiet-button",
      "data-focus-key": key,
      disabled: !!o.disabled,
      "aria-describedby": o.describedBy || null,
      text,
    });
    button.addEventListener("click", handler);
    return button;
  }

  /** Kennzeichnung neben „System-Prompt": Standard, Angepasst oder Eigener Agent */
  function promptBadge(name, p) {
    const entry = catalogEntry(name);
    const custom = entry ? entry.origin === "custom" : !!(p.data && p.data.codePrompt === null);
    const source = p.data ? p.data.promptSource : entry && entry.promptSource;
    const text = custom ? "Eigener Agent" : source === "custom" ? "Angepasst" : "Standard";
    return h("span", { className: "settings-badge", "data-prompt-source": custom ? "own" : source === "custom" ? "custom" : "code", text });
  }

  function promptBlock(name) {
    const p = promptState(name);
    const label = labelOf(name);
    const titleId = "settings-prompt-title-" + name;
    const section = h("section", { className: "settings-section settings-prompt-section", "aria-labelledby": titleId }, [
      h("div", { className: "settings-prompt-head" }, [
        h("h3", { className: "settings-label", id: titleId, text: "System-Prompt" }),
        p.data ? promptBadge(name, p) : null,
      ]),
      h("p", { className: "actions-hint", text: AGENT_TEXT.note }),
    ]);
    if (!p.data) {
      if (p.status === "failed") {
        section.appendChild(h("p", { className: "actions-error", role: "alert", text: p.error || AGENT_TEXT.promptFailed }));
        section.appendChild(h("div", { className: "settings-actions" }, [quietButton("prompt-retry:" + name, "Erneut laden", () => void loadPrompt(name))]));
      } else {
        section.appendChild(h("p", { className: "actions-hint", text: "Lädt …" }));
      }
      return section;
    }
    // Neuladen gescheitert: der vorige Stand bleibt sichtbar
    if (p.error) section.appendChild(h("p", { className: "actions-error", role: "alert", text: p.error + " " + SETTINGS_TEXT.showingLast }));
    if (p.editing) {
      const inputId = "settings-prompt-edit-" + name;
      const countId = inputId + "-count";
      const textarea = h("textarea", {
        id: inputId,
        className: "settings-input settings-textarea settings-prompt-edit",
        rows: "12",
        spellcheck: "false",
        "aria-describedby": countId,
        "aria-invalid": p.saveError ? "true" : null,
        "data-focus-key": "prompt-text:" + name,
        disabled: p.busy,
      });
      textarea.value = p.draft;
      const count = h("p", { className: "actions-hint settings-count", id: countId, text: promptCount(p.draft) });
      textarea.addEventListener("input", () => {
        p.draft = textarea.value;
        count.textContent = promptCount(p.draft);
        if (p.saveError) {
          p.saveError = null;
          render();
        }
      });
      section.appendChild(h("label", { className: "settings-sublabel", for: inputId, text: "System-Prompt für " + label + " bearbeiten" }));
      section.appendChild(textarea);
      section.appendChild(count);
      const save = h("button", {
        type: "button",
        className: "primary-button settings-save",
        "data-focus-key": "prompt-save:" + name,
        disabled: p.busy,
        text: p.busy ? "Wird gespeichert …" : "Speichern",
      });
      save.addEventListener("click", () => void savePrompt(name));
      section.appendChild(h("div", { className: "settings-actions" }, [
        save,
        quietButton("prompt-cancel:" + name, "Abbrechen", () => cancelPromptEdit(name), { disabled: p.busy }),
      ]));
      if (p.saveError) section.appendChild(h("p", { className: "actions-error", role: "alert", text: p.saveError }));
      return section;
    }
    section.appendChild(h("div", {
      className: "settings-prompt",
      role: "region",
      tabindex: "0",
      "aria-label": "System-Prompt von " + label,
      "data-focus-key": "prompt-view:" + name,
      text: p.data.systemPrompt,
    }));
    const resettable = p.data.promptSource === "custom" && p.data.codePrompt !== null;
    if (p.confirmReset && resettable) {
      section.appendChild(h("p", { className: "actions-question", text: "System-Prompt von " + label + " auf den Standard zurücksetzen?" }));
      section.appendChild(h("p", { className: "actions-hint", text: "Die angepasste Fassung geht dabei verloren. Die zusätzlichen Anweisungen bleiben." }));
      section.appendChild(h("div", { className: "settings-actions" }, [
        quietButton("prompt-reset-yes:" + name, p.busy ? "Wird zurückgesetzt …" : "Zurücksetzen", () => void resetPrompt(name), { strong: true, disabled: p.busy }),
        quietButton("prompt-reset-no:" + name, "Abbrechen", () => {
          p.confirmReset = false;
          render();
          focusKey("prompt-reset:" + name);
        }, { disabled: p.busy }),
      ]));
    } else {
      const actions = h("div", { className: "settings-actions" }, [quietButton("prompt-edit:" + name, "Bearbeiten", () => startPromptEdit(name))]);
      if (resettable) {
        actions.appendChild(quietButton("prompt-reset:" + name, "Auf Standard zurücksetzen", () => {
          p.confirmReset = true;
          p.saveError = null;
          render();
          // Fokus auf „Abbrechen": ein zweites Enter setzt nicht aus Versehen zurück
          focusKey("prompt-reset-no:" + name);
        }));
      }
      if (p.saved) actions.appendChild(h("p", { className: "settings-status", role: "status", text: "Gespeichert." }));
      section.appendChild(actions);
    }
    if (p.saveError) section.appendChild(h("p", { className: "actions-error", role: "alert", text: p.saveError }));
    return section;
  }

  function promptCount(text) {
    const n = String(text || "").replace(/\r\n?/g, "\n").length;
    return n.toLocaleString("de-DE") + " von " + PROMPT_MAX.toLocaleString("de-DE") + " Zeichen";
  }

  /** „Bei /board dabei": Segment An/Aus wie „Nur offline", speichert sofort; General nimmt nicht teil */
  function boardBlock(name) {
    const entry = catalogEntry(name);
    if (!entry) return null;
    const titleId = "settings-board-" + name;
    if (name === GENERAL_AGENT) {
      return h("div", { className: "settings-field" }, [
        h("p", { className: "settings-label", text: "Bei /board dabei" }),
        h("p", { className: "actions-hint", text: AGENT_TEXT.generalBoard }),
      ]);
    }
    const b = boardState(name);
    const value = b.busy && b.pending !== null ? b.pending : entry.board === true;
    const choices = [{ on: true, key: "on", label: "An" }, { on: false, key: "off", label: "Aus" }];
    const group = h("div", { className: "theme-switch settings-switch settings-board", role: "radiogroup", "aria-labelledby": titleId });
    choices.forEach((c, index) => {
      const checked = value === c.on;
      const button = h("button", {
        type: "button",
        className: "theme-option",
        role: "radio",
        "aria-checked": checked ? "true" : "false",
        tabindex: checked ? "0" : "-1",
        "data-focus-key": "board:" + name + ":" + c.key,
        disabled: b.busy,
        text: c.label,
      });
      button.addEventListener("click", () => void setBoard(name, c.on));
      button.addEventListener("keydown", event => {
        let next = null;
        if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) next = choices[(index + 1) % choices.length];
        else if (event.key === "Home") next = choices[0];
        else if (event.key === "End") next = choices[choices.length - 1];
        else if (event.key === " ") next = c;
        if (!next) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        void setBoard(name, next.on);
      });
      group.appendChild(button);
    });
    const field = h("div", { className: "settings-field" }, [
      h("p", { className: "settings-label", id: titleId, text: "Bei /board dabei" }),
      h("div", { className: "settings-actions" }, [
        group,
        b.busy || b.saved ? h("p", { className: "settings-status", role: "status", text: b.busy ? "Wird gespeichert …" : "Gespeichert." }) : null,
      ]),
      h("p", { className: "actions-hint", text: AGENT_TEXT.boardHint }),
    ]);
    if (b.error) field.appendChild(h("p", { className: "actions-error", role: "alert", text: b.error }));
    return field;
  }

  /**
   * Betroffenes Topic als Text: Name aus der Seitenleiste nur bei passender
   * Chat-ID; ohne Namen immer mit Chat-ID, damit kein fremdes Topic gemeint
   * scheint. "*" gilt für alle Chats.
   */
  function topicText(t, multipleChats) {
    const title = typeof deps.topicTitle === "function" ? deps.topicTitle(t.chatId, t.topicId) : null;
    let text = title ? "„" + title + "“ (Topic " + t.topicId + ")" : "Topic " + t.topicId;
    if (t.chatId === "*") text += ", in allen Chats";
    else if (multipleChats || !title) text += ", Chat " + t.chatId;
    return text;
  }

  function deleteBlock(name) {
    if (name === GENERAL_AGENT || !catalogEntry(name)) return null;
    const r = removalState(name);
    const label = labelOf(name);
    const builtin = catalogEntry(name).origin !== "custom";
    const section = h("section", { className: "settings-section", "aria-labelledby": "settings-delete-title-" + name }, [
      h("h3", { className: "settings-label", id: "settings-delete-title-" + name, text: "Agent löschen" }),
    ]);
    if (r.step === "idle" || r.step === "loading") {
      section.appendChild(h("p", { className: "actions-hint", text: builtin
        ? "Seine Topics wechseln zu General. Mitgelieferte Agenten lassen sich wiederherstellen."
        : "Seine Topics wechseln zu General. Ein eigener Agent ist danach endgültig weg." }));
      section.appendChild(h("div", { className: "settings-actions" }, [
        quietButton("delete:" + name, r.step === "loading" ? "Topics werden geprüft …" : "Agent löschen …", () => void askDelete(name), { disabled: r.step === "loading" }),
      ]));
      return section;
    }
    if (r.step === "failed") {
      section.appendChild(h("p", { className: "actions-error", role: "alert", text: r.error || AGENT_TEXT.usageFailed }));
      section.appendChild(h("div", { className: "settings-actions" }, [
        quietButton("delete-retry:" + name, "Erneut prüfen", () => void askDelete(name)),
        quietButton("delete-no:" + name, "Abbrechen", () => cancelDelete(name)),
      ]));
      return section;
    }
    // Rückfrage: nennt die Topics und verlangt die Kennung
    const busy = r.step === "busy";
    section.appendChild(h("p", { className: "actions-question", text: "„" + label + "“ löschen?" }));
    if (r.topics.length) {
      const chats = new Set(r.topics.filter(t => t.chatId !== "*").map(t => t.chatId));
      section.appendChild(h("p", { className: "actions-hint", text: r.topics.length === 1 ? "Dieses Topic wechselt zu General:" : "Diese " + r.topics.length + " Topics wechseln zu General:" }));
      const list = h("ul", { className: "settings-affected" });
      for (const t of r.topics) list.appendChild(h("li", { text: topicText(t, chats.size > 1) }));
      section.appendChild(list);
    } else {
      section.appendChild(h("p", { className: "actions-hint", text: "Kein Topic nutzt diesen Agenten." }));
    }
    section.appendChild(h("p", { className: "actions-hint", text: builtin
      ? "Unter „Gelöschte Agenten“ lässt er sich wiederherstellen, mit dem Standard-Prompt."
      : "Ein eigener Agent ist danach endgültig weg, auch sein System-Prompt." }));
    const inputId = "settings-delete-input-" + name;
    const input = h("input", {
      id: inputId,
      className: "settings-input",
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      "data-focus-key": "delete-input:" + name,
      disabled: busy,
    });
    input.value = r.input;
    const confirm = quietButton("delete-yes:" + name, busy ? "Wird gelöscht …" : "Agent löschen", () => void confirmDelete(name), {
      strong: true,
      disabled: busy || r.input !== name,
    });
    input.addEventListener("input", () => {
      r.input = input.value;
      confirm.disabled = busy || r.input !== name;
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void confirmDelete(name);
    });
    section.appendChild(h("label", { className: "settings-sublabel", for: inputId, text: "Zum Bestätigen die Kennung eintippen: " + name }));
    section.appendChild(input);
    section.appendChild(h("div", { className: "settings-actions" }, [
      confirm,
      quietButton("delete-no:" + name, "Abbrechen", () => cancelDelete(name), { disabled: busy }),
    ]));
    if (r.error) section.appendChild(h("p", { className: "actions-error", role: "alert", text: r.error }));
    return section;
  }

  /** Eingabefeld des Formulars „Neuer Agent" mit Fehler direkt darunter */
  function createField(key, labelText, control, hint) {
    const f = state.creating;
    const errorId = "settings-create-" + key + "-error";
    const hintId = hint ? "settings-create-" + key + "-hint" : null;
    const described = [hintId, f.errors[key] ? errorId : null].filter(Boolean).join(" ");
    if (described) control.setAttribute("aria-describedby", described);
    if (f.errors[key]) control.setAttribute("aria-invalid", "true");
    const field = h("div", { className: "settings-field" }, [h("label", { className: "settings-label", for: control.id, text: labelText })]);
    if (hint) field.appendChild(h("p", { className: "actions-hint", id: hintId, text: hint }));
    field.appendChild(control.tagName === "SELECT" ? h("span", { className: "settings-select" }, [control]) : control);
    return field;
  }

  function fieldError(key) {
    const text = state.creating.errors[key];
    return text ? h("p", { className: "actions-error", id: "settings-create-" + key + "-error", role: "alert", text }) : null;
  }

  function createSection() {
    const f = state.creating;
    if (!f) {
      return h("div", { className: "settings-actions settings-create-open" }, [
        quietButton("create-open", "Neuer Agent", openCreate, { strong: true }),
      ]);
    }
    const input = (key, props, onInput) => {
      const node = h(props.tag || "input", Object.assign({
        id: "settings-create-" + key,
        className: "settings-input",
        autocomplete: "off",
        "data-focus-key": "create-" + key,
        disabled: f.busy,
      }, props.attrs));
      node.value = f[props.field || key];
      node.addEventListener(props.tag === "select" ? "change" : "input", () => {
        f[props.field || key] = node.value;
        if (f.errors[key] || f.errors.form) {
          delete f.errors[key];
          delete f.errors.form;
          render();
        } else if (onInput) onInput();
      });
      return node;
    };
    const name = input("name", { attrs: { type: "text", autocapitalize: "off", spellcheck: "false", placeholder: "z.B. projekt-planer" } });
    const description = input("description", { attrs: { type: "text", placeholder: "Eine Zeile: wofür der Agent da ist" } });
    const prompt = input("prompt", { tag: "textarea", attrs: { className: "settings-input settings-textarea settings-prompt-edit", rows: "8", spellcheck: "false" } });

    const model = h("select", { id: "settings-create-model", className: "settings-input", "data-focus-key": "create-model", disabled: f.busy });
    model.appendChild(h("option", { value: MODEL_DEFAULT, text: "Standard (allgemeine Einstellung)" }));
    for (const m of state.claudeModels) model.appendChild(h("option", { value: m, text: m }));
    model.appendChild(h("option", { value: MODEL_CUSTOM, text: "Eigenes Modell …" }));
    model.value = f.model;
    model.addEventListener("change", () => {
      f.model = model.value;
      delete f.errors.model;
      render();
      if (f.model === MODEL_CUSTOM) focusKey("create-custom");
    });
    const effort = h("select", { id: "settings-create-effort", className: "settings-input", "data-focus-key": "create-effort", disabled: f.busy });
    effort.appendChild(h("option", { value: EFFORT_DEFAULT, text: SETTINGS_TEXT.effortByModel }));
    for (const level of Array.isArray(state.data.effortLevels) ? state.data.effortLevels : []) effort.appendChild(h("option", { value: String(level), text: String(level) }));
    effort.value = f.effort;
    effort.addEventListener("change", () => {
      f.effort = effort.value;
    });

    const modelField = createField("model", "Modell", model);
    if (f.model === MODEL_CUSTOM) {
      const custom = input("custom", { attrs: { type: "text", spellcheck: "false", placeholder: "Modell-ID, z.B. claude-sonnet-5", "aria-label": "Eigenes Modell für den neuen Agenten" } });
      custom.addEventListener("input", () => {
        if (f.errors.model) {
          delete f.errors.model;
          render();
        }
      });
      modelField.appendChild(custom);
    }
    const submit = h("button", {
      type: "button",
      className: "primary-button settings-save",
      "data-focus-key": "create-submit",
      disabled: f.busy,
      text: f.busy ? "Wird angelegt …" : "Agent anlegen",
    });
    submit.addEventListener("click", () => void submitCreate());
    const nodes = [
      createField("name", "Kennung", name, "a-z, 0-9 und -, 2 bis 30 Zeichen. Lässt sich später nicht ändern."),
      fieldError("name"),
      createField("description", "Beschreibung", description),
      fieldError("description"),
      createField("prompt", "System-Prompt", prompt),
      fieldError("prompt"),
      modelField,
      fieldError("model"),
      createField("effort", "Effort", effort),
      h("p", { className: "actions-hint", text: "Der neue Agent antwortet über den Haupt-Bot und ist bei /board aus, bis du ihn einschaltest." }),
      h("div", { className: "settings-actions" }, [submit, quietButton("create-cancel", "Abbrechen", closeCreate, { disabled: f.busy })]),
      f.errors.form ? h("p", { className: "actions-error", role: "alert", text: f.errors.form }) : null,
    ];
    return h("section", { className: "settings-section settings-create", "aria-labelledby": "settings-create-title" },
      [h("h3", { className: "settings-label", id: "settings-create-title", text: "Neuer Agent" })].concat(nodes.filter(Boolean)));
  }

  function deletedSection() {
    const data = state.catalog.data;
    const deleted = data && Array.isArray(data.deleted) ? data.deleted.filter(d => d && typeof d.name === "string" && AGENT_ID.test(d.name)) : [];
    if (!deleted.length) return null;
    const list = h("ul", { className: "settings-deleted" });
    for (const d of deleted) {
      const label = typeof d.label === "string" && d.label.trim() ? d.label.trim() : deps.agentLabel(d.name) || d.name;
      const busy = state.restoring === d.name;
      const item = h("li", {}, [
        h("div", { className: "settings-deleted-text" }, [
          h("span", { className: "settings-agent-name", "data-agent": d.name }, [h("span", { className: "agent-dot" }), h("span", { text: label })]),
          typeof d.description === "string" && d.description ? h("span", { className: "conversation-meta", text: d.description }) : null,
        ]),
        quietButton("restore:" + d.name, busy ? "Wird wiederhergestellt …" : "Wiederherstellen", () => void restoreAgent(d.name), {
          disabled: !!state.restoring,
        }),
      ]);
      list.appendChild(item);
      if (state.restoreError && state.restoreError.name === d.name) {
        list.appendChild(h("li", { className: "settings-deleted-error" }, [h("p", { className: "actions-error", role: "alert", text: state.restoreError.text })]));
      }
    }
    return sectionNode("deleted", "Gelöschte Agenten", ["Mitgelieferte Agenten kommen mit ihrem Standard-Prompt zurück. Topics, die zu General gewechselt sind, bleiben dort."], [list]);
  }

  function agentNoticeNode() {
    const n = state.agentNotice;
    if (!n) return null;
    return h("p", {
      className: n.kind === "warn" ? "settings-notice settings-agent-notice" : "settings-status settings-agent-notice",
      role: n.kind === "warn" ? "alert" : "status",
      tabindex: "-1",
      "data-focus-key": "agent-notice",
      text: n.text,
    });
  }

  /** Katalog fehlt oder das letzte Laden scheiterte: Meldung mit „Erneut laden" */
  function catalogProblemNodes() {
    const c = state.catalog;
    if (!c.error) return [];
    const retry = quietButton("catalog-retry", "Erneut laden", () => void loadCatalog());
    return [h("div", { className: "settings-sync" }, [
      h("p", { className: "actions-error", role: "alert", text: c.data ? c.error + " " + SETTINGS_TEXT.showingLast : c.error }),
      retry,
    ])];
  }

  function agentRow(name) {
    const open = state.expanded.has(name);
    const label = labelOf(name);
    const head = h("button", {
      type: "button",
      className: "conversation settings-agent-head",
      "aria-expanded": open ? "true" : "false",
      "aria-controls": "settings-agent-" + name,
      "data-focus-key": "agent:" + name,
    }, [
      h("span", { className: "settings-agent-name", "data-agent": name }, [
        h("span", { className: "agent-dot" }),
        h("span", { className: "settings-agent-label", text: label }),
      ]),
      h("span", { className: "conversation-meta settings-agent-meta", text: summary(name) }),
      chevron(),
    ]);
    head.addEventListener("click", () => toggleAgent(name));
    const item = h("li", { className: "settings-agent" }, [head]);
    if (!open) return item;
    const f = form(name);
    const entry = catalogEntry(name);
    const body = h("div", { className: "settings-agent-body", id: "settings-agent-" + name, role: "group", "aria-label": "Einstellungen für " + label });
    if (entry && typeof entry.description === "string" && entry.description) {
      body.appendChild(h("p", { className: "actions-hint settings-agent-description", text: entry.description }));
    }
    // Prompt oberhalb von Modell und Anweisungen (Issue #51)
    body.appendChild(promptBlock(name));
    body.appendChild(modelField(name, f));
    body.appendChild(effortField(name, f));
    body.appendChild(h("p", { className: "actions-hint settings-note", text: SETTINGS_TEXT.modelNote }));
    for (const node of saveBlock(name, f)) body.appendChild(node);
    const board = boardBlock(name);
    if (board) body.appendChild(board);
    body.appendChild(instructionsBlock(name));
    const remove = deleteBlock(name);
    if (remove) body.appendChild(remove);
    item.appendChild(body);
    return item;
  }

  function toggleAgent(name) {
    if (state.expanded.has(name)) state.expanded.delete(name);
    else {
      state.expanded.add(name);
      const i = inst(name);
      if (i.status === "idle" || i.status === "failed") void loadInstructions(name);
      const p = promptState(name);
      if (p.status === "idle" || p.status === "failed") void loadPrompt(name);
    }
    render();
  }

  /** Meldung und „Erneut laden", solange der letzte Abgleich fehlgeschlagen ist */
  function syncFailedNodes() {
    const retry = h("button", {
      type: "button",
      className: "quiet-button",
      "data-focus-key": "settings-retry",
      disabled: !!state.loading,
      text: state.loading ? "Lädt …" : "Erneut laden",
    });
    retry.addEventListener("click", () => void load());
    const text = state.data ? SETTINGS_TEXT.loadFailed + " " + SETTINGS_TEXT.showingLast : SETTINGS_TEXT.loadFailed;
    return [h("p", { className: "actions-error", role: "alert", text }), retry];
  }

  // --- Anzeige „Modelle" ---------------------------------------------------------

  /**
   * Füllt eine Modell-Auswahl: erst „Standard (…)" bzw. „Modell wählen …",
   * dann die Treffer des Filters, zuletzt „Eigenes Modell …". Der gewählte
   * Eintrag bleibt auch stehen, wenn der Filter ihn ausblendet. Gefiltert wird
   * nur hier im Browser, ohne Anfrage an den Server.
   */
  function fillModelOptions(select, f, entries, defaultLabel, count) {
    const options = [defaultLabel === null
      ? h("option", { value: MODEL_NONE, text: "Modell wählen …" })
      : h("option", { value: MODEL_DEFAULT, text: defaultLabel })];
    const matches = filterEntries(entries, f.filter);
    const shown = matches.slice(0, FILTER_SHOW_MAX);
    const current = entries.find(e => e.id === f.choice);
    if (current && !shown.includes(current)) shown.unshift(current);
    for (const entry of shown) options.push(h("option", { value: entry.id, text: entry.label }));
    options.push(h("option", { value: MODEL_CUSTOM, text: "Eigenes Modell …" }));
    select.replaceChildren(...options);
    select.value = f.choice;
    if (!count) return;
    const filtered = String(f.filter || "").trim();
    if (!filtered) count.textContent = entries.length + " Modelle in der Liste.";
    else if (!matches.length) count.textContent = "Keine Treffer.";
    else if (matches.length > FILTER_SHOW_MAX) count.textContent = "Zeigt " + FILTER_SHOW_MAX + " von " + matches.length + " Treffern, bitte genauer filtern.";
    else count.textContent = matches.length === 1 ? "1 Treffer." : matches.length + " Treffer.";
  }

  /**
   * Modell-Feld eines Abschnitts: Filterfeld (bei langen Listen), Auswahl,
   * bei „Eigenes Modell …" ein Textfeld. o: { section, key, label, entries,
   * defaultLabel (null: kein „Standard"), listName }
   */
  function globalModelField(o) {
    const g = globalForm(o.section);
    const f = g.fields[o.key];
    const fieldKey = o.section + "." + o.key;
    const id = "settings-g-" + o.section + "-" + o.key;
    const field = h("div", { className: "settings-field" }, [h("label", { className: "settings-label", for: id, text: o.label })]);
    let count = null;
    const select = h("select", { id, className: "settings-input", "data-focus-key": "g-model:" + fieldKey, disabled: g.saving });
    if (o.entries.length >= FILTER_MIN) {
      const filter = h("input", {
        type: "search",
        className: "settings-input",
        placeholder: LIST_LABELS[o.listName] + "-Liste filtern …",
        "aria-label": o.label + ": Liste filtern",
        "aria-controls": id,
        autocomplete: "off",
        spellcheck: "false",
        "data-focus-key": "g-filter:" + fieldKey,
        disabled: g.saving,
      });
      filter.value = f.filter || "";
      count = h("p", { className: "actions-hint", role: "status", "aria-live": "polite" });
      filter.addEventListener("input", () => {
        f.filter = filter.value;
        fillModelOptions(select, f, o.entries, o.defaultLabel, count);
      });
      field.appendChild(filter);
    }
    fillModelOptions(select, f, o.entries, o.defaultLabel, count);
    select.addEventListener("change", () => {
      f.choice = select.value;
      g.error = null;
      clearSaved(g);
      render();
      if (f.choice === MODEL_CUSTOM) focusKey("g-custom:" + fieldKey);
    });
    field.appendChild(h("span", { className: "settings-select" }, [select]));
    if (count) field.appendChild(count);
    const listError = o.listName && state.listErrors[o.listName];
    if (listError) {
      field.appendChild(h("p", { className: "actions-hint", role: "status", text: listError + ". Eigenes Modell bleibt möglich." }));
    }
    if (f.choice === MODEL_CUSTOM) {
      const custom = h("input", {
        id: id + "-custom",
        className: "settings-input",
        type: "text",
        placeholder: o.listName === "openrouter" ? "Modell-ID, z.B. vendor/modell" : o.listName === "ollama" ? "Modellname, z.B. qwen3:8b" : o.listName === "opencode" ? "anbieter/modell, z.B. openrouter/anthropic/claude-opus-5.5" : "Modell-ID, z.B. claude-sonnet-5",
        "aria-label": "Eigenes Modell: " + o.label,
        autocomplete: "off",
        spellcheck: "false",
        "data-focus-key": "g-custom:" + fieldKey,
        disabled: g.saving,
      });
      custom.value = f.custom;
      custom.addEventListener("input", () => {
        f.custom = custom.value;
        g.error = null;
        clearSaved(g);
        updateGlobalSave(o.section);
      });
      custom.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        void saveGlobal(o.section);
      });
      field.appendChild(custom);
    }
    return field;
  }

  /** Speichern-Knopf und „Standard" beim Effort ohne Neuzeichnen nachführen (beim Tippen) */
  function updateGlobalSave(section) {
    if (typeof document.querySelector !== "function") return;
    const g = globalForm(section);
    const button = document.querySelector('[data-focus-key="save:section-' + section + '"]');
    if (button) button.disabled = g.saving || !isGlobalDirty(section) || !!(state.data && state.data.fileInvalid);
    if (section !== "defaults") return;
    const effort = document.querySelector('[data-focus-key="g-effort:defaults.effort"]');
    if (effort && effort.options && effort.options[0]) effort.options[0].textContent = defaultsEffortLabel();
  }

  /** „Standard" beim Standardmodell: null heißt, je Agent gilt etwas anderes */
  function defaultsInheritedLabel(entry) {
    return entry === null ? "Standard (je Agent aus der Voreinstellung)" : inheritedLabel(entry);
  }

  /** Wie effortDefaultLabel: bei geändertem Standardmodell kein Wert statt eines falschen */
  function defaultsEffortLabel() {
    const g = globalForm("defaults");
    if (globalFieldEdited(GLOBAL_SECTIONS.defaults[0], g.fields.model, savedGlobal("defaults").model)) return SETTINGS_TEXT.effortByModel;
    return defaultsInheritedLabel(inheritedGlobal("defaults").effort);
  }

  function sectionNode(id, title, hints, children) {
    const section = h("section", { className: "settings-section", "aria-labelledby": "settings-g-title-" + id }, [
      h("h3", { className: "settings-label", id: "settings-g-title-" + id, text: title }),
    ]);
    for (const hint of hints) if (hint) section.appendChild(h("p", { className: "actions-hint", text: hint }));
    for (const child of children) if (child) section.appendChild(child);
    return section;
  }

  function globalSaveNodes(section) {
    const g = globalForm(section);
    return saveControls("section-" + section, g, isGlobalDirty(section), () => void saveGlobal(section));
  }

  /** Welche Agenten eigene Werte haben und vom Standard nicht betroffen sind */
  function ownersHint() {
    const parts = [];
    for (const name of agentNames()) {
      const own = ownEntry(name);
      const fields = [];
      if (typeof own.model === "string") fields.push("Modell");
      if (typeof own.effort === "string") fields.push("Effort");
      if (fields.length) parts.push((deps.agentLabel(name) || name) + " (" + fields.join(" und ") + ")");
    }
    return parts.length ? "Eigene Werte im Reiter Agenten behalten: " + parts.join(", ") + "." : null;
  }

  function defaultsSection() {
    const g = globalForm("defaults");
    const inh = inheritedGlobal("defaults");
    const effortSelect = h("select", { id: "settings-g-defaults-effort", className: "settings-input", "data-focus-key": "g-effort:defaults.effort", disabled: g.saving });
    effortSelect.appendChild(h("option", { value: EFFORT_DEFAULT, text: defaultsEffortLabel() }));
    for (const level of Array.isArray(state.data.effortLevels) ? state.data.effortLevels : []) {
      effortSelect.appendChild(h("option", { value: String(level), text: String(level) }));
    }
    effortSelect.value = g.fields.effort.choice;
    effortSelect.addEventListener("change", () => {
      g.fields.effort.choice = effortSelect.value;
      g.error = null;
      clearSaved(g);
      render();
    });
    const nodes = [
      globalModelField({ section: "defaults", key: "model", label: "Modell", entries: state.lists.claude, defaultLabel: defaultsInheritedLabel(inh.model), listName: "claude" }),
      h("div", { className: "settings-field" }, [
        h("label", { className: "settings-label", for: "settings-g-defaults-effort", text: "Effort" }),
        h("span", { className: "settings-select" }, [effortSelect]),
      ]),
    ].concat(globalSaveNodes("defaults"));
    return sectionNode("defaults", "Standard für alle Agenten", [
      "Gilt für jeden Agenten ohne eigenen Wert, ab seiner nächsten Nachricht. Gilt für Claude Code; Codex und OpenCode haben eigene Werte im Reiter Agenten unter Motor.",
      ownersHint(),
    ], nodes);
  }

  /** Nebenmodell: Anbieter und Modell aus der passenden Liste oder frei eingegeben */
  function auxField(purpose) {
    const g = globalForm("aux");
    const f = g.fields[purpose];
    const inherited = inheritedGlobal("aux")[purpose];
    const id = "settings-g-aux-" + purpose + "-provider";
    const provider = h("select", { id, className: "settings-input", "data-focus-key": "g-provider:aux." + purpose, disabled: g.saving });
    provider.appendChild(h("option", { value: PROVIDER_DEFAULT, text: inheritedLabel(inherited) }));
    for (const p of PROVIDERS) provider.appendChild(h("option", { value: p.id, text: p.label }));
    provider.value = f.provider;
    provider.addEventListener("change", () => {
      const next = provider.value;
      f.provider = next;
      f.custom = "";
      f.filter = "";
      f.choice = MODEL_NONE;
      // Derselbe Anbieter wie beim geerbten Wert: dessen Modell vorwählen
      const inh = splitAuxSpec(inherited && inherited.value);
      if (inh && inh.provider === next) {
        if (state.lists[next].some(e => e.id === inh.model)) f.choice = inh.model;
        else {
          f.choice = MODEL_CUSTOM;
          f.custom = inh.model;
        }
      }
      g.error = null;
      clearSaved(g);
      render();
    });
    const titleId = "settings-g-aux-" + purpose + "-title";
    const group = h("div", { className: "settings-field settings-aux", role: "group", "aria-labelledby": titleId }, [
      h("h4", { className: "settings-label", id: titleId, text: AUX_LABELS[purpose] }),
      h("p", { className: "actions-hint", text: AUX_HINTS[purpose] }),
      h("label", { className: "settings-sublabel", for: id, text: "Anbieter" }),
      h("span", { className: "settings-select" }, [provider]),
    ]);
    if (f.provider !== PROVIDER_DEFAULT) {
      group.appendChild(globalModelField({
        section: "aux",
        key: purpose,
        label: "Modell (" + (PROVIDERS.find(p => p.id === f.provider) || { label: f.provider }).label + ")",
        entries: state.lists[f.provider] || [],
        defaultLabel: null,
        listName: f.provider,
      }));
    }
    return group;
  }

  function auxSection() {
    return sectionNode("aux", "Nebenmodelle", [
      'Nebenaufgaben laufen auf eigenen Modellen. „Standard" nennt, was ohne eigenen Wert gilt.',
    ], AUX_PURPOSES.map(auxField).concat(globalSaveNodes("aux")));
  }

  /** „Nur offline (Ollama)" als Segment-Steuerung: Standard, An, Aus */
  function offlineField() {
    const g = globalForm("fallback");
    const f = g.fields.offlineOnly;
    const inherited = inheritedGlobal("fallback").offlineOnly;
    const choices = [
      { value: OFFLINE_DEFAULT, label: "Standard" },
      { value: "true", label: "An" },
      { value: "false", label: "Aus" },
    ];
    const choose = value => {
      f.choice = value;
      g.error = null;
      clearSaved(g);
      render();
      focusKey("g-offline:" + value);
    };
    const group = h("div", { className: "theme-switch settings-switch", role: "radiogroup", "aria-labelledby": "settings-g-offline-label" });
    choices.forEach((c, index) => {
      const checked = f.choice === c.value;
      const button = h("button", {
        type: "button",
        className: "theme-option",
        role: "radio",
        "aria-checked": checked ? "true" : "false",
        tabindex: checked ? "0" : "-1",
        "data-focus-key": "g-offline:" + c.value,
        disabled: g.saving,
        text: c.label,
      });
      button.addEventListener("click", () => choose(c.value));
      button.addEventListener("keydown", event => {
        let next = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = choices[(index + 1) % choices.length];
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = choices[(index - 1 + choices.length) % choices.length];
        else if (event.key === "Home") next = choices[0];
        else if (event.key === "End") next = choices[choices.length - 1];
        else if (event.key === " ") next = c;
        if (!next) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        choose(next.value);
      });
      group.appendChild(button);
    });
    const standard = inherited && typeof inherited.value === "boolean"
      ? "Standard ist zurzeit " + (inherited.value ? "an" : "aus") + (SOURCE_LABELS[inherited.source] ? " (" + SOURCE_LABELS[inherited.source] + ")" : "") + "."
      : null;
    return h("div", { className: "settings-field" }, [
      h("p", { className: "settings-label", id: "settings-g-offline-label", text: "Nur offline (Ollama)" }),
      group,
      h("p", { className: "actions-hint", text: "An: Der Fallback überspringt OpenRouter und nutzt nur das lokale Ollama. Claude und die Nebenmodelle bleiben davon unberührt." + (standard ? " " + standard : "") }),
    ]);
  }

  function fallbackSection() {
    const inh = inheritedGlobal("fallback");
    return sectionNode("fallback", "Fallback", [
      "Springt ein, wenn Claude nicht antwortet.",
    ], [
      globalModelField({ section: "fallback", key: "openrouterModel", label: "OpenRouter-Modell", entries: state.lists.openrouter, defaultLabel: inheritedLabel(inh.openrouterModel), listName: "openrouter" }),
      globalModelField({ section: "fallback", key: "ollamaModel", label: "Ollama-Modell", entries: state.lists.ollama, defaultLabel: inheritedLabel(inh.ollamaModel), listName: "ollama" }),
      offlineField(),
    ].concat(globalSaveNodes("fallback")));
  }

  // --- Abschnitt „Offene Fäden" (Issue #293) -----------------------------------

  /** „Standard (…)" mit Quelle für einen Wert, der kein Text ist */
  function threadsDefaultLabel(entry, format) {
    if (!entry || typeof entry !== "object" || entry.value === undefined || entry.value === null) return "Standard";
    const source = SOURCE_LABELS[entry.source];
    return "Standard (" + format(entry.value) + (source ? ", " + source : "") + ")";
  }

  function daysText(n) {
    return n === 1 ? "1 Tag" : String(n).replace(".", ",") + " Tage";
  }

  function hourText(n) {
    return String(n).padStart(2, "0") + ":00";
  }

  function quietText(q) {
    return q && typeof q === "object" ? hourText(q.from) + " bis " + hourText(q.to) : "";
  }

  /** An/Aus als Segment wie „Nur offline": Standard, An, Aus */
  function threadsEnabledField() {
    const g = globalForm("threads");
    const f = g.fields.enabled;
    const inherited = inheritedGlobal("threads").enabled;
    const choices = [
      { value: OFFLINE_DEFAULT, label: "Standard" },
      { value: "true", label: "An" },
      { value: "false", label: "Aus" },
    ];
    const choose = value => {
      f.choice = value;
      g.error = null;
      clearSaved(g);
      render();
      focusKey("g-threads-enabled:" + value);
    };
    const group = h("div", { className: "theme-switch settings-switch", role: "radiogroup", "aria-labelledby": "settings-g-threads-enabled-label" });
    choices.forEach((c, index) => {
      const checked = f.choice === c.value;
      const button = h("button", {
        type: "button",
        className: "theme-option",
        role: "radio",
        "aria-checked": checked ? "true" : "false",
        tabindex: checked ? "0" : "-1",
        "data-focus-key": "g-threads-enabled:" + c.value,
        disabled: g.saving,
        text: c.label,
      });
      button.addEventListener("click", () => choose(c.value));
      button.addEventListener("keydown", event => {
        let next = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = choices[(index + 1) % choices.length];
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = choices[(index - 1 + choices.length) % choices.length];
        else if (event.key === "Home") next = choices[0];
        else if (event.key === "End") next = choices[choices.length - 1];
        else if (event.key === " ") next = c;
        if (!next) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        choose(next.value);
      });
      group.appendChild(button);
    });
    const standard = inherited && typeof inherited.value === "boolean"
      ? "Standard ist zurzeit " + (inherited.value ? "an" : "aus") + (SOURCE_LABELS[inherited.source] ? " (" + SOURCE_LABELS[inherited.source] + ")" : "") + "."
      : null;
    return h("div", { className: "settings-field" }, [
      h("p", { className: "settings-label", id: "settings-g-threads-enabled-label", text: "Fäden merken und erinnern" }),
      group,
      h("p", { className: "actions-hint", text: THREADS_SETTINGS_TEXT.enabledHint + (standard ? " " + standard : "") }),
    ]);
  }

  function threadsDaysField() {
    const g = globalForm("threads");
    const f = g.fields.remindDays;
    const id = "settings-g-threads-days";
    const select = h("select", { id, className: "settings-input", "data-focus-key": "g-threads:remindDays", disabled: g.saving });
    select.appendChild(h("option", { value: CHOICE_DEFAULT, text: threadsDefaultLabel(inheritedGlobal("threads").remindDays, daysText) }));
    for (let n = 1; n <= THREADS_DAYS_MAX; n++) select.appendChild(h("option", { value: String(n), text: daysText(n) }));
    select.value = f.choice;
    select.addEventListener("change", () => {
      f.choice = select.value;
      g.error = null;
      clearSaved(g);
      render();
    });
    return h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: id, text: "Erinnerung nach" }),
      h("span", { className: "settings-select" }, [select]),
      h("p", { className: "actions-hint", text: THREADS_SETTINGS_TEXT.daysHint }),
    ]);
  }

  /** Stunde von oder bis der Ruhezeit */
  function quietHourSelect(f, g, key, label) {
    const id = "settings-g-threads-quiet-" + key;
    const select = h("select", { id, className: "settings-input", "data-focus-key": "g-threads:quiet-" + key, disabled: g.saving });
    for (let n = 0; n <= 23; n++) select.appendChild(h("option", { value: String(n), text: hourText(n) }));
    select.value = f[key];
    select.addEventListener("change", () => {
      f[key] = select.value;
      g.error = null;
      clearSaved(g);
      render();
    });
    return h("div", { className: "settings-field" }, [
      h("label", { className: "settings-sublabel", for: id, text: label }),
      h("span", { className: "settings-select" }, [select]),
    ]);
  }

  function threadsQuietField() {
    const g = globalForm("threads");
    const f = g.fields.quietHours;
    const inherited = inheritedGlobal("threads").quietHours;
    const id = "settings-g-threads-quiet";
    const mode = h("select", { id, className: "settings-input", "data-focus-key": "g-threads:quiet", disabled: g.saving });
    mode.appendChild(h("option", { value: QUIET_DEFAULT, text: threadsDefaultLabel(inherited, quietText) }));
    mode.appendChild(h("option", { value: QUIET_OWN, text: "Eigene Zeiten" }));
    mode.value = f.mode;
    mode.addEventListener("change", () => {
      f.mode = mode.value;
      // Eigene Zeiten beginnen mit dem, was bisher galt
      if (f.mode === QUIET_OWN && (f.from === "" || f.to === "")) {
        const q = inherited && inherited.value && typeof inherited.value === "object" ? inherited.value : { from: 21, to: 8 };
        f.from = String(q.from);
        f.to = String(q.to);
      }
      g.error = null;
      clearSaved(g);
      render();
    });
    const field = h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: id, text: "Ruhezeit" }),
      h("span", { className: "settings-select" }, [mode]),
    ]);
    if (f.mode === QUIET_OWN) {
      field.appendChild(h("div", { className: "settings-quiet" }, [quietHourSelect(f, g, "from", "Von"), quietHourSelect(f, g, "to", "Bis")]));
    }
    field.appendChild(h("p", { className: "actions-hint", text: THREADS_SETTINGS_TEXT.quietHint }));
    return field;
  }

  function threadsSection() {
    return sectionNode("threads", "Offene Fäden", [THREADS_SETTINGS_TEXT.intro], [
      threadsEnabledField(),
      threadsDaysField(),
      threadsQuietField(),
    ].concat(globalSaveNodes("threads")));
  }

  // --- Anzeige „Motor" (Issue #126) --------------------------------------------

  function engineList() {
    const list = state.data && state.data.engineOptions && Array.isArray(state.data.engineOptions.engines) ? state.data.engineOptions.engines : ENGINE_FALLBACK;
    return list.filter(e => e && typeof e.id === "string" && typeof e.label === "string");
  }

  function engineName(id) {
    const hit = engineList().find(e => e.id === id);
    return hit ? hit.label : String(id);
  }

  /** Auswahlfeld eines Abschnittsfelds (Motor, Codex-Effort, Rechte) mit Neuzeichnen bei Änderung */
  function engineSelect(key, label, options, hint) {
    const g = globalForm("engine");
    const f = g.fields[key];
    const id = "settings-g-engine-" + key;
    const select = h("select", { id, className: "settings-input", "data-focus-key": "g-engine:" + key, disabled: g.saving });
    for (const o of options) select.appendChild(h("option", { value: o.value, text: o.text }));
    select.value = f.choice;
    select.addEventListener("change", () => {
      f.choice = select.value;
      g.error = null;
      clearSaved(g);
      render();
    });
    const field = h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: id, text: label }),
      h("span", { className: "settings-select" }, [select]),
    ]);
    if (hint) field.appendChild(h("p", { className: "actions-hint", text: hint }));
    return field;
  }

  /** „Standard (Claude Code, Voreinstellung)": was ohne eigenen Wert gilt (TYBO_ENGINE oder Claude Code) */
  function engineDefaultLabel() {
    const inh = state.data.inheritedModels && state.data.inheritedModels.engine && state.data.inheritedModels.engine.default;
    if (!inh || typeof inh.value !== "string") return "Standard";
    const source = SOURCE_LABELS[inh.source];
    return "Standard (" + engineName(inh.value) + (source ? ", " + source : "") + ")";
  }

  function availabilityNode() {
    const e = state.engines;
    if (!e.data) {
      return h("p", { className: e.phase === "failed" ? "actions-error" : "actions-hint", role: "status", text: e.phase === "failed" ? e.error || ENGINE_TEXT.failed : ENGINE_TEXT.checking });
    }
    const list = Array.isArray(e.data.availability) ? e.data.availability : null;
    if (!list) return h("p", { className: "actions-hint", role: "status", text: ENGINE_TEXT.availabilityUnknown });
    const ul = h("ul", { className: "settings-keys settings-engines", "aria-label": "Verfügbarkeit der Motoren" });
    for (const a of list) {
      if (!a || typeof a.engine !== "string") continue;
      const ready = a.installed === true && a.loggedIn === true;
      const item = h("li", { "data-set": ready ? "true" : "false", "data-engine": a.engine }, [
        h("span", { className: "settings-key-name", text: typeof a.label === "string" ? a.label : engineName(a.engine) }),
        h("span", { className: "settings-key-state", text: engineAvailabilityText(a) }),
      ]);
      ul.appendChild(item);
    }
    return ul;
  }

  function codexModelField() {
    return engineTextField("codexModel", "Modell", "Standard aus der Codex-Konfiguration");
  }

  /** Freies Textfeld eines Motor-Felds (Codex-Modell, OpenCode-Variante); Enter speichert */
  function engineTextField(key, label, placeholder, hint) {
    const g = globalForm("engine");
    const f = g.fields[key];
    const id = "settings-g-engine-" + key;
    const input = h("input", {
      id,
      className: "settings-input",
      type: "text",
      placeholder,
      autocomplete: "off",
      spellcheck: "false",
      "data-focus-key": "g-engine:" + key,
      disabled: g.saving,
    });
    input.value = f.text;
    input.addEventListener("input", () => {
      f.text = input.value;
      g.error = null;
      clearSaved(g);
      updateGlobalSave("engine");
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void saveGlobal("engine");
    });
    const field = h("div", { className: "settings-field" }, [h("label", { className: "settings-label", for: id, text: label }), input]);
    if (hint) field.appendChild(h("p", { className: "actions-hint", text: hint }));
    return field;
  }

  /** Verfügbarkeit von OpenCode aus GET /api/engines (checkEngine), im Abschnitt OpenCode */
  function openCodeAvailabilityNode() {
    const e = state.engines;
    const list = e.data && Array.isArray(e.data.availability) ? e.data.availability : null;
    const a = list && list.find(x => x && x.engine === "opencode");
    if (!a) return null;
    const ready = a.installed === true && a.loggedIn === true;
    const text = ready || typeof a.message !== "string" || !a.message ? engineAvailabilityText(a) : a.message;
    return h("p", { className: "actions-hint settings-engine-state", role: "status", "data-engine": "opencode", "data-ready": ready ? "true" : "false", text: "OpenCode: " + text });
  }

  function openCodeGroup(options) {
    const titleId = "settings-g-engine-opencode";
    const levels = Array.isArray(options.opencodePermissionLevels) ? options.opencodePermissionLevels : Object.keys(PERMISSION_LABELS);
    const standard = typeof options.opencodeDefaultPermission === "string" ? options.opencodeDefaultPermission : PERMISSION_DEFAULT;
    const permissionOrder = ["auto", "ask-deny"].filter(v => levels.includes(v));
    const nodes = [
      h("h4", { className: "settings-label", id: titleId, text: "OpenCode" }),
      h("p", { className: "actions-hint", text: ENGINE_TEXT.opencodeNote }),
      openCodeAvailabilityNode(),
      globalModelField({
        section: "engine",
        key: "opencodeModel",
        label: "Modell",
        entries: state.lists.opencode,
        defaultLabel: "Standard aus der OpenCode-Konfiguration",
        listName: "opencode",
      }),
    ];
    // Ohne Liste (Abruf gescheitert, ältere Antwort): das Feld bleibt frei eingebbar
    if (!state.lists.opencode.length && !state.listErrors.opencode) {
      nodes.push(h("p", { className: "actions-hint", role: "status", text: ENGINE_TEXT.opencodeNoList }));
    }
    nodes.push(
      engineTextField("opencodeVariant", "Variante (Effort)", "Standard von OpenCode", ENGINE_TEXT.variantHint),
      engineSelect(
        "opencodePermission",
        "Rechte",
        permissionOrder.map(v => ({ value: v, text: PERMISSION_LABELS[v] + (v === standard ? " (Standard)" : "") })),
        ENGINE_TEXT.permissionNote
      )
    );
    return h("div", { className: "settings-field settings-aux", role: "group", "aria-labelledby": titleId }, nodes.filter(Boolean));
  }

  function overridesNode() {
    const e = state.engines;
    const titleId = "settings-g-engine-overrides";
    const nodes = [
      h("h4", { className: "settings-label", id: titleId, text: ENGINE_TEXT.overridesTitle }),
      h("p", { className: "actions-hint", text: ENGINE_TEXT.overridesHint }),
    ];
    if (e.notice) nodes.push(h("p", { className: "settings-status", role: "status", tabindex: "-1", "data-focus-key": "engine-reset-done", text: e.notice }));
    if (!e.data) {
      if (e.phase === "failed") {
        const again = quietButton("engine-reload", "Erneut laden", () => void loadEngines());
        nodes.push(again);
      }
      return h("div", { className: "settings-field", role: "group", "aria-labelledby": titleId }, nodes);
    }
    const list = e.data.overrides.filter(o => o && typeof o.key === "string");
    if (!list.length) {
      nodes.push(h("p", { className: "settings-empty", text: ENGINE_TEXT.overridesEmpty }));
      return h("div", { className: "settings-field", role: "group", "aria-labelledby": titleId }, nodes);
    }
    const ul = h("ul", { className: "settings-engine-overrides", "aria-labelledby": titleId });
    for (const o of list) {
      const gone = o.conversationId === null || typeof o.title !== "string";
      const busy = e.resetting === o.key;
      const name = h("span", { className: "settings-engine-conversation" }, [
        h("span", { className: "settings-engine-title", text: gone ? ENGINE_TEXT.gone : o.title }),
        h("span", { className: "engine-pill", "data-engine": String(o.engine), text: typeof o.label === "string" ? o.label : engineName(o.engine) }),
      ]);
      const button = quietButton("engine-reset:" + o.key, busy ? "Wird zurückgesetzt …" : "Auf Standard", () => void resetEngineOverride(o.key), {
        disabled: !!e.resetting,
      });
      button.setAttribute("aria-label", "Auf Standard: " + (gone ? ENGINE_TEXT.gone : o.title));
      const row = h("li", { "data-key": o.key }, [name, button]);
      if (gone) row.appendChild(h("p", { className: "actions-hint", text: ENGINE_TEXT.goneHint }));
      if (e.rowError && e.rowError.key === o.key) row.appendChild(h("p", { className: "actions-error", role: "alert", text: e.rowError.text }));
      ul.appendChild(row);
    }
    nodes.push(ul);
    // Fehler zu einer Zeile, die es nicht mehr gibt (404): über der Liste
    if (e.rowError && !list.some(o => o.key === e.rowError.key)) nodes.push(h("p", { className: "actions-error", role: "alert", text: e.rowError.text }));
    return h("div", { className: "settings-field", role: "group", "aria-labelledby": titleId }, nodes);
  }

  function engineSection() {
    const options = state.data.engineOptions && typeof state.data.engineOptions === "object" ? state.data.engineOptions : {};
    const efforts = Array.isArray(options.codexEffortLevels) ? options.codexEffortLevels : [];
    const sandboxes = Array.isArray(options.codexSandboxLevels) ? options.codexSandboxLevels : Object.keys(SANDBOX_LABELS);
    const sandboxOrder = ["full", "workspace-write", "read-only"].filter(v => sandboxes.includes(v));
    const codexTitle = "settings-g-engine-codex";
    const codex = h("div", { className: "settings-field settings-aux", role: "group", "aria-labelledby": codexTitle }, [
      h("h4", { className: "settings-label", id: codexTitle, text: "Codex" }),
      h("p", { className: "actions-hint", text: ENGINE_TEXT.codexNote }),
      codexModelField(),
      engineSelect("codexEffort", "Effort", [{ value: CHOICE_DEFAULT, text: "Standard aus der Codex-Konfiguration" }].concat(efforts.map(l => ({ value: String(l), text: String(l) })))),
      engineSelect(
        "codexSandbox",
        "Rechte",
        sandboxOrder.map(v => ({ value: v, text: SANDBOX_LABELS[v] + (v === SANDBOX_DEFAULT ? " (Standard)" : "") })),
        ENGINE_TEXT.sandboxNote
      ),
    ]);
    return sectionNode("engine", "Motor", [ENGINE_TEXT.intro], [
      availabilityNode(),
      engineSelect("default", "Standard-Motor", [{ value: CHOICE_DEFAULT, text: engineDefaultLabel() }].concat(engineList().map(e => ({ value: e.id, text: e.label })))),
      codex,
      // Nur, wenn der Server OpenCode als wählbar nennt (ältere Antworten kennen engine.opencode nicht)
      engineList().some(e => e.id === "opencode") ? openCodeGroup(options) : null,
      ...globalSaveNodes("engine"),
      overridesNode(),
    ]);
  }

  function modelsPanel() {
    const nodes = [h("p", { className: "settings-intro", text: "Modelle für alle Agenten, die Nebenaufgaben und den Fallback, dazu die offenen Fäden. Speichern gilt pro Abschnitt." })];
    if (state.listsFailed) nodes.push(h("p", { className: "actions-hint settings-lists-failed", role: "status", text: SETTINGS_TEXT.listsFailed }));
    nodes.push(defaultsSection(), auxSection(), fallbackSection());
    // Ältere Server kennen den Abschnitt nicht
    if (state.data && state.data.inheritedModels && state.data.inheritedModels.threads) nodes.push(threadsSection());
    return nodes;
  }

  // --- Anzeige „Sprechen" (Issue #248) -----------------------------------------

  function speechOptionsData() {
    const o = state.data && state.data.speechOptions;
    return o && typeof o === "object" && Array.isArray(o.stt) && Array.isArray(o.tts) ? o : null;
  }

  /** Anbieter einer Stufe (stt oder tts) aus speechOptions, nur mit Kennung und Namen */
  function speechProviders(key) {
    const o = speechOptionsData();
    return o ? o[key].filter(p => p && typeof p.id === "string" && typeof p.label === "string") : [];
  }

  function speechLanguages() {
    const o = speechOptionsData();
    const list = o && Array.isArray(o.languages) ? o.languages : Object.keys(LANGUAGE_LABELS);
    return list.filter(code => typeof code === "string" && /^[a-z]{2}$/.test(code));
  }

  function speechValueLabel(key, value) {
    if (value === SPEECH_AUTO) return SPEECH_TEXT.auto;
    if (key === "language") return LANGUAGE_LABELS[value] || value;
    const hit = speechProviders(key).find(p => p.id === value);
    return hit ? hit.label : value;
  }

  /** „Standard (Automatisch, Voreinstellung)" bzw. „Standard (Gemini, .env)" */
  function speechDefaultLabel(key) {
    const inh = inheritedGlobal("speech")[key];
    if (!inh || typeof inh.value !== "string") return "Standard";
    const source = SOURCE_LABELS[inh.source];
    return "Standard (" + speechValueLabel(key, inh.value) + (source ? ", " + source : "") + ")";
  }

  /** Was die Auswahl gerade bedeutet: eigener Wert, sonst der geerbte */
  function speechSelected(key) {
    const f = globalForm("speech").fields[key];
    if (f.choice !== CHOICE_DEFAULT) return { value: f.choice, fixed: true };
    const inh = inheritedGlobal("speech")[key];
    return { value: inh && typeof inh.value === "string" ? inh.value : SPEECH_AUTO, fixed: false };
  }

  /** Hinweise unter einer Auswahl: lokal oder Cloud, Grund bei nicht verfügbar, Browser-Stimme */
  function speechHints(key) {
    if (key === "language") return [SPEECH_TEXT.language];
    const selected = speechSelected(key);
    if (selected.value === SPEECH_AUTO) return [key === "stt" ? SPEECH_TEXT.autoStt : SPEECH_TEXT.autoTts];
    const p = speechProviders(key).find(x => x.id === selected.value);
    if (!p) return [];
    const out = [];
    if (p.available !== true) out.push({ error: true, text: "Nicht verfügbar: " + (typeof p.reason === "string" && p.reason ? p.reason : "ohne Angabe") + "." });
    out.push(p.local ? "Lokal." : (key === "stt" ? "Cloud: Audio geht an " : "Cloud: Text geht an ") + p.label + ".");
    // Namensnennung bzw. Lizenz der lokalen Stimmen (Issue #252)
    if (typeof p.note === "string" && p.note) out.push(/[.!?]$/.test(p.note) ? p.note : p.note + ".");
    if (key === "tts" && p.id === "browser") out.push(SPEECH_TEXT.browser);
    else if (p.available !== true || selected.fixed) out.push(SPEECH_TEXT.fixed);
    return out;
  }

  /**
   * Auswahl Hören, Sprechen oder Sprache. Nicht verfügbare Anbieter stehen
   * ausgegraut in der Liste, auch der gespeicherte: er bleibt als gewählter
   * Wert sichtbar und unverändert, lässt sich aber nicht neu wählen. Ein
   * gespeicherter Wert, der nicht in der Liste steht, wird ergänzt.
   */
  function speechSelect(key, label) {
    const g = globalForm("speech");
    const f = g.fields[key];
    const saved = savedGlobal("speech")[key];
    const id = "settings-g-speech-" + key;
    const hintId = id + "-hint";
    const select = h("select", { id, className: "settings-input", "data-focus-key": "g-speech:" + key, "aria-describedby": hintId, disabled: g.saving });
    const listed = [];
    const add = (value, text, disabled) => {
      listed.push(value);
      select.appendChild(h("option", { value, text, disabled: !!disabled }));
    };
    add(CHOICE_DEFAULT, speechDefaultLabel(key));
    add(SPEECH_AUTO, SPEECH_TEXT.auto);
    if (key === "language") {
      for (const code of speechLanguages()) add(code, LANGUAGE_LABELS[code] || code);
    } else {
      for (const p of speechProviders(key)) {
        const available = p.available === true;
        const text = p.label + (available ? "" : " (nicht verfügbar" + (typeof p.reason === "string" && p.reason ? ": " + p.reason : "") + ")");
        add(p.id, text, !available);
      }
    }
    for (const value of [saved, f.choice]) {
      if (typeof value === "string" && !listed.includes(value)) add(value, speechValueLabel(key, value));
    }
    select.value = f.choice;
    select.addEventListener("change", () => {
      f.choice = select.value;
      g.error = null;
      clearSaved(g);
      render();
    });
    const hints = h("div", { id: hintId });
    for (const hint of speechHints(key)) {
      if (typeof hint === "string") hints.appendChild(h("p", { className: "actions-hint", text: hint }));
      else hints.appendChild(h("p", { className: "actions-error", text: hint.text }));
    }
    return h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: id, text: label }),
      h("span", { className: "settings-select" }, [select]),
      hints,
    ]);
  }

  /** Der Server kennt den Telefonhörer (modes.call in GET /api/voice, bereit oder nicht) */
  function callKnown() {
    return !!state.voice.call;
  }

  /** Status des Sprechmodus aus GET /api/voice */
  function voiceStatusNode() {
    const v = state.voice;
    if (!v.data) {
      return h("p", { className: v.phase === "failed" ? "actions-error" : "actions-hint", role: "status", text: v.phase === "failed" ? SPEECH_TEXT.statusFailed : SPEECH_TEXT.statusLoading });
    }
    const local = v.data;
    const stt = local.stt && typeof local.stt.label === "string" ? local.stt.label : null;
    const tts = local.tts && typeof local.tts.label === "string" ? local.tts.label : null;
    const text = local.ready
      ? "Sprechmodus bereit: Hören mit " + stt + ", Sprechen mit " + tts + "."
      : "Sprechmodus nicht bereit" + (typeof local.reason === "string" && local.reason ? ": " + local.reason : "") + ".";
    return h("p", { className: "actions-hint settings-voice-status", role: "status", "data-ready": local.ready ? "true" : "false", text });
  }

  function speechPanel() {
    const nodes = [h("p", { className: "settings-intro", text: SPEECH_TEXT.intro }), h("p", { className: "actions-hint", text: SPEECH_TEXT.recommended })];
    if (!speechOptionsData()) nodes.push(h("p", { className: "actions-hint", role: "status", text: SPEECH_TEXT.noOptions }));
    nodes.push(sectionNode("speech", "Hören und Sprechen", [], [
      voiceStatusNode(),
      speechSelect("stt", "Hören"),
      speechSelect("tts", "Sprechen"),
      speechSelect("language", "Sprache"),
      speechModelNode(),
      speechEffortNode(),
    ].concat(globalSaveNodes("speech"))));
    // Telefonhörer (Issue #260): Stand, Modellweg und Probe, nur wenn der Server ihn kennt
    if (callKnown()) nodes.push(callServerSection());
    // Pro Gerät (Issue #250): getrennt vom Formular oben, sofort und nur in diesem Browser gespeichert
    if (speechDevice) nodes.push(...speechDevice.nodes());
    // Telefonhörer pro Gerät (Issue #258): nur, wenn der Server ihn kennt (modes.call im Status)
    if (callDevice && callKnown()) nodes.push(...callDevice.nodes());
    // Eigene Stimme (Issue #253): eigene Routen, nie Teil von PATCH /api/settings
    if (voiceClone) nodes.push(...voiceClone.nodes());
    return nodes;
  }

  // --- Abschnitt „Telefonhörer" (Issue #260) -----------------------------------

  /** Gespeicherter Stand speech.call aus GET /api/settings */
  function savedCall() {
    const sp = state.data && state.data.settings && state.data.settings.speech;
    const c = sp && sp.call && typeof sp.call === "object" ? sp.call : {};
    return {
      model: typeof c.model === "string" ? c.model : null,
      claudeVia: c.claudeVia === "api" || c.claudeVia === "cli" ? c.claudeVia : null,
      // Stimme (Issue #276): null heißt nicht gespeichert (auto bzw. Standard)
      tts: typeof c.tts === "string" ? c.tts : null,
      // Erkenner (Issue #279): null heißt nicht gespeichert (auto)
      stt: typeof c.stt === "string" ? c.stt : null,
      voiceId: typeof c.elevenlabsVoice === "string" ? c.elevenlabsVoice : null,
      voiceModel: typeof c.elevenlabsModel === "string" ? c.elevenlabsModel : null,
    };
  }

  /** Stimme im Formular: gespeichert oder geändert */
  function callVoiceValues() {
    const f = state.callForm;
    const saved = savedCall();
    return {
      tts: f.tts !== null ? f.tts : saved.tts || CALL_TTS_DEFAULT,
      stt: f.stt !== null ? f.stt : saved.stt || CALL_STT_DEFAULT,
      voiceId: f.voiceId !== null ? f.voiceId : saved.voiceId || "",
      model: f.model !== null ? f.model : saved.voiceModel || "",
    };
  }

  function callWays() {
    const c = state.voice.call;
    return c && Array.isArray(c.ways) ? c.ways.filter(w => w && typeof w.id === "string" && typeof w.model === "string" && typeof w.label === "string") : [];
  }

  /** Auswahl zum gespeicherten Stand: Standard, Automatisch, ein Weg (id) oder Eigenes */
  function savedCallChoice() {
    const saved = savedCall();
    if (saved.model === null) return { choice: CALL_CHOICE_DEFAULT, custom: "" };
    if (saved.model === "auto") return { choice: CALL_CHOICE_AUTO, custom: "" };
    const way = callWays().find(w => w.model === saved.model && (w.claudeVia || null) === (w.model.startsWith("claude:") ? saved.claudeVia : null));
    return way ? { choice: way.id, custom: "" } : { choice: CALL_CHOICE_CUSTOM, custom: saved.model };
  }

  function callFormValues() {
    const f = state.callForm;
    return f.choice === null ? savedCallChoice() : { choice: f.choice, custom: f.custom };
  }

  /** speech.call-Teil für PATCH: { patch } (null ohne Änderung) oder { error } */
  function callPatch() {
    const v = callFormValues();
    let next;
    if (v.choice === CALL_CHOICE_DEFAULT) next = { model: null, claudeVia: null };
    else if (v.choice === CALL_CHOICE_AUTO) next = { model: "auto", claudeVia: null };
    else if (v.choice === CALL_CHOICE_CUSTOM) {
      const model = String(v.custom || "").trim();
      if (!CALL_MODEL_PATTERN.test(model)) return { error: CALL_SETTINGS_TEXT.customInvalid };
      next = { model, claudeVia: null };
    } else {
      const way = callWays().find(w => w.id === v.choice);
      if (!way) return { patch: null };
      next = { model: way.model, claudeVia: way.claudeVia || null };
    }
    const saved = savedCall();
    const patch = {};
    if (saved.model !== next.model) patch.model = next.model;
    if (saved.claudeVia !== next.claudeVia) patch.claudeVia = next.claudeVia;
    // Stimme (Issue #276): auto und leere Felder entfernen den Eintrag
    const voice = callVoiceValues();
    const voiceId = String(voice.voiceId || "").trim();
    if (voiceId && !CALL_VOICE_ID_PATTERN.test(voiceId)) return { error: CALL_SETTINGS_TEXT.voiceIdInvalid };
    const nextTts = voice.tts === CALL_TTS_DEFAULT ? null : voice.tts;
    if ((saved.tts || null) !== nextTts) patch.tts = nextTts;
    // Erkenner (Issue #279): auto entfernt den Eintrag
    const nextStt = voice.stt === CALL_STT_DEFAULT ? null : voice.stt;
    if ((saved.stt || null) !== nextStt) patch.stt = nextStt;
    if ((saved.voiceId || null) !== (voiceId || null)) patch.elevenlabsVoice = voiceId || null;
    if ((saved.voiceModel || null) !== (voice.model || null)) patch.elevenlabsModel = voice.model || null;
    return { patch: Object.keys(patch).length ? patch : null };
  }

  async function saveCall() {
    const f = state.callForm;
    if (f.saving) return;
    const result = callPatch();
    if (result.error) {
      f.error = result.error;
      render();
      return;
    }
    if (!result.patch) return;
    f.saving = true;
    f.error = null;
    clearSaved(f);
    render();
    const attempt = ++state.sync.next;
    let error = null;
    try {
      const { ok, data, status } = await deps.api("PATCH", "/api/settings", { speech: { call: result.patch } });
      if (ok && data && typeof data === "object" && data.settings) {
        adoptIfNewer(data, attempt);
        f.saving = false;
        f.choice = null;
        f.custom = "";
        f.tts = null;
        f.stt = null;
        f.voiceId = null;
        f.model = null;
        f.saved = true;
        f.savedTimer = later(() => {
          f.saved = false;
          f.savedTimer = null;
          render();
        }, SAVED_MS);
        state.callProbe = { phase: "idle", result: null, error: null };
        render();
        // Neuer Weg: Stand und Erwartung frisch vom Server
        void loadVoice();
        return;
      }
      error = errorText(data, "Speichern fehlgeschlagen (Fehler " + status + ").");
    } catch {
      error = SETTINGS_TEXT.offline;
    }
    f.saving = false;
    f.error = error;
    render();
  }

  async function runCallProbe() {
    const p = state.callProbe;
    if (p.phase === "busy") return;
    state.callProbe = { phase: "busy", result: null, error: null };
    render();
    try {
      const { ok, data, status } = await deps.api("POST", "/api/voice/call/probe");
      if (ok && data && data.probe && typeof data.probe === "object") {
        const r = data.probe;
        state.callProbe = r.ok === true && typeof r.text === "string"
          ? { phase: "done", result: r, error: null }
          : { phase: "done", result: null, error: typeof r.reason === "string" && r.reason ? r.reason : "Die Probe ist gescheitert." };
      } else {
        state.callProbe = { phase: "done", result: null, error: errorText(data, "Probe fehlgeschlagen (Fehler " + status + ").") };
      }
    } catch {
      state.callProbe = { phase: "done", result: null, error: CALL_SETTINGS_TEXT.probeOffline };
    }
    render();
  }

  /** Stand des Telefonhörers mit dem nächsten Schritt; ohne sicheren Kontext auch der */
  function callStatusNodes(c) {
    const nodes = [];
    const insecure = typeof window !== "undefined" && window.isSecureContext === false;
    const ways = callWays();
    if (c.ready) {
      const active = ways.find(w => w.ready && w.model.endsWith(":" + c.model) && (!w.claudeVia || w.claudeVia === c.via));
      nodes.push(h("p", { className: "actions-hint settings-call-status", role: "status", "data-ready": "true", text: "Telefonhörer bereit" + (active ? ": " + active.label : c.model ? ": " + c.model : "") + "." }));
    } else {
      const reasons = [];
      if (!c.stt || !c.stt.id) reasons.push(CALL_SETTINGS_TEXT.noStt);
      if (!ways.some(w => w.ready) && (!c.via || !c.model)) reasons.push(CALL_SETTINGS_TEXT.noWay);
      const reason = typeof c.reason === "string" && c.reason ? c.reason : "";
      nodes.push(h("p", { className: "actions-error settings-call-status", role: "status", "data-ready": "false", text: "Telefonhörer nicht bereit" + (reason ? ": " + reason : "") + (/[.!?]$/.test(reason) ? "" : ".") }));
      for (const r of reasons) nodes.push(h("p", { className: "actions-hint", text: r }));
      nodes.push(h("p", { className: "actions-hint settings-call-next", text: CALL_SETTINGS_TEXT.nextStep }));
    }
    if (insecure) {
      nodes.push(h("p", { className: "actions-error settings-call-insecure", text: CALL_SETTINGS_TEXT.insecure }));
      nodes.push(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.insecureStep }));
    }
    return nodes;
  }

  function callModelNode() {
    const f = state.callForm;
    const v = callFormValues();
    const id = "settings-call-model";
    const hintId = id + "-hint";
    const select = h("select", { id, className: "settings-input", "data-focus-key": "call-model", "aria-describedby": hintId, disabled: f.saving });
    select.appendChild(h("option", { value: CALL_CHOICE_DEFAULT, text: CALL_SETTINGS_TEXT.default }));
    select.appendChild(h("option", { value: CALL_CHOICE_AUTO, text: CALL_SETTINGS_TEXT.auto }));
    for (const w of callWays()) {
      // Nicht bereite Wege bleiben sichtbar, aber nicht wählbar; ein schon gewählter bleibt ausgewählt
      select.appendChild(h("option", { value: w.id, text: w.label + (w.ready ? "" : CALL_SETTINGS_TEXT.notReady), disabled: !w.ready && v.choice !== w.id }));
    }
    select.appendChild(h("option", { value: CALL_CHOICE_CUSTOM, text: CALL_SETTINGS_TEXT.custom }));
    select.value = v.choice;
    select.addEventListener("change", () => {
      const now = callFormValues();
      f.choice = select.value;
      f.custom = select.value === CALL_CHOICE_CUSTOM ? now.custom : "";
      f.error = null;
      clearSaved(f);
      render();
    });
    const hints = h("div", { id: hintId });
    const c = state.voice.call;
    if (c && typeof c.expectation === "string" && c.expectation) hints.appendChild(h("p", { className: "actions-hint settings-call-expectation", text: "Erwartung: " + c.expectation + "." }));
    if (c && c.billing === "subscription") hints.appendChild(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.subscription }));
    else if (c && c.via === "cli" && c.billing === "anthropic-api") hints.appendChild(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.apiKeyCli }));
    else if (c && (c.billing === "anthropic-api" || c.billing === "openrouter")) hints.appendChild(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.costs }));
    // Warum ein Weg nicht bereit ist
    for (const w of callWays()) {
      if (!w.ready && w.reason) hints.appendChild(h("p", { className: "actions-hint settings-call-way", text: w.label + ": " + w.reason }));
    }
    const nodes = [
      h("label", { className: "settings-label", for: id, text: CALL_SETTINGS_TEXT.modelLabel }),
      h("span", { className: "settings-select" }, [select]),
    ];
    if (v.choice === CALL_CHOICE_CUSTOM) {
      const input = h("input", { id: "settings-call-custom", className: "settings-input", type: "text", "data-focus-key": "call-custom", value: v.custom, placeholder: "ollama:qwen3:8b", spellcheck: "false", autocomplete: "off", disabled: f.saving });
      input.addEventListener("input", () => {
        f.choice = CALL_CHOICE_CUSTOM;
        f.custom = input.value;
        f.error = null;
        clearSaved(f);
        render();
      });
      nodes.push(h("label", { className: "settings-label", for: "settings-call-custom", text: CALL_SETTINGS_TEXT.customLabel }), input, h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.customHint }));
    }
    nodes.push(hints);
    return h("div", { className: "settings-field" }, nodes);
  }

  function callProbeNodes() {
    const p = state.callProbe;
    const c = state.voice.call;
    const button = h("button", {
      type: "button",
      className: "quiet-button",
      "data-focus-key": "call-probe",
      disabled: p.phase === "busy" || !c || !c.ready || c.probe !== true,
      text: p.phase === "busy" ? CALL_SETTINGS_TEXT.probeBusy : CALL_SETTINGS_TEXT.probe,
    });
    button.addEventListener("click", () => void runCallProbe());
    const nodes = [h("div", { className: "settings-actions" }, [button, h("p", { className: "settings-status", role: "status", text: p.phase === "done" && p.result ? p.result.text + "." : "" })])];
    nodes.push(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.probeHint }));
    if (p.phase === "done" && p.error) nodes.push(h("p", { className: "actions-error", role: "alert", text: p.error }));
    return nodes;
  }

  function callVoiceNodes(c) {
    const sttOption = c.stt && c.stt.id ? callSttOptions().find(o => o.id === c.stt.id) : null;
    const stt = c.stt && c.stt.id ? (sttOption ? sttOption.label : c.stt.id) + (c.stt.id === "elevenlabs" && c.stt.fallback ? ", Rückfall " + c.stt.fallback : "") : null;
    const t = c.tts || {};
    const name = typeof t.voiceName === "string" && t.voiceName ? " (" + t.voiceName + ")" : "";
    const tts = t.where === "server" ? t.id + name : "Browser-Stimme";
    const nodes = [h("p", { className: "actions-hint settings-call-voice-now", text: "Hören: " + (stt || "kein lokaler Erkenner") + ", Sprechen: " + tts + ". " + CALL_SETTINGS_TEXT.voiceRef })];
    if (c.stt && typeof c.stt.reason === "string" && c.stt.reason && c.stt.setting && c.stt.setting !== CALL_STT_DEFAULT) nodes.push(h("p", { className: "actions-error settings-call-stt-reason", text: c.stt.reason + "." }));
    if (typeof t.reason === "string" && t.reason) nodes.push(h("p", { className: "actions-error settings-call-tts-reason", text: t.reason + "." }));
    if (t.where !== "server") nodes.push(h("p", { className: "actions-hint settings-call-browser-voice", text: CALL_SETTINGS_TEXT.browserVoice }));
    return nodes;
  }

  /** Wählbare Erkenner aus modes.call.stt.options (Issue #279) */
  function callSttOptions() {
    const c = state.voice.call;
    const list = c && c.stt && Array.isArray(c.stt.options) ? c.stt.options : [];
    return list.filter(o => o && typeof o.id === "string" && typeof o.label === "string");
  }

  /** Erkenner des Telefonhörers mit Daten-, Kosten- und Rückfallhinweis (Issue #279) */
  function callSttNode() {
    const f = state.callForm;
    const v = callVoiceValues();
    const options = callSttOptions();
    const id = "settings-call-stt";
    const hintId = id + "-hint";
    const select = h("select", { id, className: "settings-input", "data-focus-key": "call-stt", "aria-describedby": hintId, disabled: f.saving });
    for (const o of options) {
      // Nicht verfügbare Erkenner sichtbar, aber nicht wählbar; ein schon gewählter bleibt ausgewählt
      select.appendChild(h("option", { value: o.id, text: o.label + (o.available ? "" : CALL_SETTINGS_TEXT.ttsUnavailable), disabled: !o.available && v.stt !== o.id }));
    }
    if (!options.some(o => o.id === v.stt)) select.appendChild(h("option", { value: v.stt, text: v.stt }));
    select.value = v.stt;
    select.addEventListener("change", () => {
      f.stt = select.value;
      f.error = null;
      clearSaved(f);
      render();
    });
    const hints = h("div", { id: hintId });
    for (const o of options) {
      if (!o.available && o.reason) hints.appendChild(h("p", { className: "actions-hint settings-call-stt-why", text: o.label + ": " + o.reason }));
    }
    if (v.stt === CALL_STT_DEFAULT) hints.appendChild(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.sttAuto }));
    if (v.stt === "elevenlabs") {
      const parakeet = options.find(o => o.id === "parakeet");
      for (const text of [CALL_SETTINGS_TEXT.scribeData, CALL_SETTINGS_TEXT.scribeCost, CALL_SETTINGS_TEXT.scribeKey, parakeet && parakeet.available ? CALL_SETTINGS_TEXT.scribeFallback : CALL_SETTINGS_TEXT.scribeNoFallback]) {
        hints.appendChild(h("p", { className: "actions-hint settings-call-scribe", text }));
      }
    }
    return h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: id, text: CALL_SETTINGS_TEXT.sttLabel }),
      h("span", { className: "settings-select" }, [select]),
      hints,
    ]);
  }

  /** Wählbare Stimmen aus modes.call.tts.options (Issue #276) */
  function callTtsOptions() {
    const c = state.voice.call;
    const list = c && c.tts && Array.isArray(c.tts.options) ? c.tts.options : [];
    return list.filter(o => o && typeof o.id === "string" && typeof o.label === "string");
  }

  /** Stimme des Telefonhörers mit ElevenLabs-Feldern, Kosten- und Datenhinweis (Issue #276) */
  function callTtsNode() {
    const f = state.callForm;
    const v = callVoiceValues();
    const options = callTtsOptions();
    const id = "settings-call-tts";
    const hintId = id + "-hint";
    const select = h("select", { id, className: "settings-input", "data-focus-key": "call-tts", "aria-describedby": hintId, disabled: f.saving });
    for (const o of options) {
      // Nicht verfügbare Stimmen sichtbar, aber nicht wählbar; eine schon gewählte bleibt ausgewählt
      select.appendChild(h("option", { value: o.id, text: o.label + (o.available ? "" : CALL_SETTINGS_TEXT.ttsUnavailable), disabled: !o.available && v.tts !== o.id }));
    }
    if (!options.some(o => o.id === v.tts)) select.appendChild(h("option", { value: v.tts, text: v.tts }));
    select.value = v.tts;
    select.addEventListener("change", () => {
      f.tts = select.value;
      f.error = null;
      clearSaved(f);
      render();
    });
    const hints = h("div", { id: hintId });
    for (const o of options) {
      if (!o.available && o.reason) hints.appendChild(h("p", { className: "actions-hint settings-call-tts-why", text: o.label + ": " + o.reason }));
    }
    const nodes = [
      h("label", { className: "settings-label", for: id, text: CALL_SETTINGS_TEXT.ttsLabel }),
      h("span", { className: "settings-select" }, [select]),
    ];
    if (v.tts === CALL_TTS_DEFAULT) hints.appendChild(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.ttsAuto }));
    if (v.tts === "elevenlabs") {
      const c = state.voice.call;
      const pocket = options.find(o => o.id === "pocket");
      for (const text of [CALL_SETTINGS_TEXT.elevenCost, CALL_SETTINGS_TEXT.elevenData, CALL_SETTINGS_TEXT.elevenKey, pocket && pocket.available ? CALL_SETTINGS_TEXT.elevenFallback : CALL_SETTINGS_TEXT.elevenNoFallback]) {
        hints.appendChild(h("p", { className: "actions-hint settings-call-eleven", text }));
      }
      const placeholder = c && c.tts && typeof c.tts.voice === "string" ? c.tts.voice : "";
      const input = h("input", { id: "settings-call-voice", className: "settings-input", type: "text", "data-focus-key": "call-voice", value: v.voiceId, placeholder, spellcheck: "false", autocomplete: "off", maxlength: "64", disabled: f.saving });
      input.addEventListener("input", () => {
        f.voiceId = input.value;
        f.error = null;
        clearSaved(f);
        render();
      });
      const model = h("select", { id: "settings-call-voice-model", className: "settings-input", "data-focus-key": "call-voice-model", disabled: f.saving });
      model.appendChild(h("option", { value: "", text: CALL_SETTINGS_TEXT.modelDefault11 }));
      const models = c && c.tts && Array.isArray(c.tts.models) ? c.tts.models : [];
      for (const m of models) if (m && typeof m.id === "string") model.appendChild(h("option", { value: m.id, text: typeof m.label === "string" ? m.label : m.id }));
      if (v.model && !models.some(m => m && m.id === v.model)) model.appendChild(h("option", { value: v.model, text: v.model }));
      model.value = v.model;
      model.addEventListener("change", () => {
        f.model = model.value;
        f.error = null;
        clearSaved(f);
        render();
      });
      nodes.push(hints);
      nodes.push(
        h("label", { className: "settings-label", for: "settings-call-voice", text: CALL_SETTINGS_TEXT.voiceIdLabel }),
        input,
        h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.voiceIdHint }),
        h("label", { className: "settings-label", for: "settings-call-voice-model", text: CALL_SETTINGS_TEXT.modelLabel11 }),
        h("span", { className: "settings-select" }, [model]),
      );
      return h("div", { className: "settings-field" }, nodes);
    }
    nodes.push(hints);
    return h("div", { className: "settings-field" }, nodes);
  }

  async function runCallListen() {
    const l = state.callListen;
    if (l.phase === "busy") return;
    forgetCallListen();
    state.callListen = { phase: "busy", url: "", error: null, autoplay: false, node: null };
    render();
    let next;
    try {
      const res = await fetch("/api/voice/call/voice-probe", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (res.ok) {
        const blob = await res.blob();
        next = { phase: "done", url: window.URL.createObjectURL(blob), error: null, autoplay: true, node: null };
      } else {
        let data = null;
        try {
          data = await res.json();
        } catch {
          // keine JSON-Antwort
        }
        next = { phase: "done", url: "", error: data && typeof data.error === "string" ? data.error : CALL_SETTINGS_TEXT.listenFailed, autoplay: false, node: null };
      }
    } catch {
      next = { phase: "done", url: "", error: CALL_SETTINGS_TEXT.probeOffline, autoplay: false, node: null };
    }
    state.callListen = next;
    render();
  }

  function forgetCallListen() {
    const l = state.callListen;
    if (!l.url) return;
    try {
      window.URL.revokeObjectURL(l.url);
    } catch {
      // egal
    }
  }

  function callListenNodes() {
    const l = state.callListen;
    const c = state.voice.call;
    const server = !!(c && c.tts && c.tts.where === "server");
    const button = h("button", {
      type: "button",
      className: "quiet-button",
      "data-focus-key": "call-listen",
      disabled: l.phase === "busy" || !server || !c || c.voiceProbe !== true,
      text: l.phase === "busy" ? CALL_SETTINGS_TEXT.listenBusy : CALL_SETTINGS_TEXT.listen,
    });
    button.addEventListener("click", () => void runCallListen());
    const nodes = [h("div", { className: "settings-actions" }, [button])];
    if (l.url) {
      // Ein Element je Ton, damit Neuzeichnen die Wiedergabe nicht abbricht
      if (!l.node) l.node = h("audio", { className: "settings-call-listen-audio", controls: true, preload: "auto", src: l.url, "aria-label": CALL_SETTINGS_TEXT.listen });
      if (l.autoplay) {
        l.autoplay = false;
        try {
          const p = l.node.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {
          // Abspielen nur nach Tipp: die Steuerung steht da
        }
      }
      nodes.push(l.node);
    }
    nodes.push(h("p", { className: "actions-hint", text: CALL_SETTINGS_TEXT.listenHint }));
    if (l.phase === "done" && l.error) nodes.push(h("p", { className: "actions-error", role: "alert", text: l.error }));
    return nodes;
  }

  function callServerSection() {
    const c = state.voice.call;
    const dirty = !!callPatch().error || !!callPatch().patch;
    return sectionNode("call", CALL_SETTINGS_TEXT.title, [CALL_SETTINGS_TEXT.intro], [
      ...callStatusNodes(c),
      callModelNode(),
      // Nur wenn der Server Erkenner zur Wahl meldet (Issue #279)
      ...(callSttOptions().length ? [callSttNode()] : []),
      callTtsNode(),
      ...saveControls("call", state.callForm, dirty, () => void saveCall()),
      ...callProbeNodes(),
      ...callVoiceNodes(c),
      ...callListenNodes(),
    ]);
  }

  /** Modell für gesprochene Fragen (Issue #249): leer heißt wie das Gespräch */
  function speechModelNode() {
    const field = globalModelField({
      section: "speech",
      key: "model",
      label: SPEECH_TEXT.modelLabel,
      entries: speechModelEntries(),
      defaultLabel: SPEECH_TEXT.modelDefault,
      listName: "speech",
    });
    field.appendChild(h("p", { className: "actions-hint", text: SPEECH_TEXT.model }));
    return field;
  }

  function speechEffortNode() {
    const g = globalForm("speech");
    const id = "settings-g-speech-effort";
    const hintId = id + "-hint";
    const select = h("select", { id, className: "settings-input", "data-focus-key": "g-effort:speech.effort", "aria-describedby": hintId, disabled: g.saving });
    select.appendChild(h("option", { value: EFFORT_DEFAULT, text: SPEECH_TEXT.effortDefault }));
    const levels = Array.isArray(state.data.effortLevels) ? state.data.effortLevels.map(String) : [];
    // Ein gespeicherter Wert außerhalb der Liste bleibt sichtbar und wird nicht überschrieben
    const saved = g.fields.effort.choice;
    if (saved !== EFFORT_DEFAULT && !levels.includes(saved)) levels.push(saved);
    for (const level of levels) select.appendChild(h("option", { value: level, text: level }));
    select.value = g.fields.effort.choice;
    select.addEventListener("change", () => {
      g.fields.effort.choice = select.value;
      g.error = null;
      clearSaved(g);
      render();
    });
    return h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: id, text: SPEECH_TEXT.effortLabel }),
      h("span", { className: "settings-select" }, [select]),
      h("p", { className: "actions-hint", id: hintId, text: SPEECH_TEXT.effort }),
    ]);
  }

  // --- Anzeige „Schlüssel" (Issue #63) -----------------------------------------

  /** „gesetzt ••••abcd", „gesetzt" (kurz oder gesperrt, last4 null) oder „fehlt" */
  function keyStateText(k) {
    if (k.set !== true) return "fehlt";
    const last4 = k.locked !== true && typeof k.last4 === "string" && k.last4.length === 4 ? k.last4 : null;
    return last4 ? "gesetzt ••••" + last4 : "gesetzt";
  }

  function keyButton(key, text, handler, options) {
    const o = options || {};
    const b = h("button", { type: "button", className: o.strong ? "quiet-button action-confirm" : "quiet-button", "data-focus-key": key, disabled: !!o.disabled, text });
    b.addEventListener("click", handler);
    return b;
  }

  function keyEditorNode(k, ed) {
    const label = h("label", { className: "settings-label", for: ed.input.id, text: (ed.mode === "replace" ? "Neuer Wert für " : "Wert für ") + k.name });
    const nodes = [label, ed.input];
    if (ed.error) nodes.push(h("p", { className: "actions-error", role: "alert", text: ed.error }));
    nodes.push(h("div", { className: "settings-actions" }, [
      keyButton("key-save:" + k.name, ed.busy ? "Speichert …" : "Speichern", () => void submitKey(k.name), { strong: true, disabled: ed.busy }),
      keyButton("key-cancel:" + k.name, "Abbrechen", () => cancelKeyEditor(k.name), { disabled: ed.busy }),
    ]));
    return h("div", { className: "settings-field settings-key-editor" }, nodes);
  }

  function keyConfirmNode(k) {
    const busy = state.keys.removing === k.name;
    return h("div", { className: "settings-key-editor" }, [
      h("p", { className: "actions-question", text: k.name + " aus der .env entfernen?" }),
      h("p", { className: "actions-hint", text: "Der Wert ist danach weg. Wirksam nach einem Neustart." }),
      h("div", { className: "settings-actions" }, [
        keyButton("key-remove-yes:" + k.name, busy ? "Wird entfernt …" : "Entfernen", () => void confirmRemoveKey(k.name), { strong: true, disabled: busy }),
        keyButton("key-remove-no:" + k.name, "Abbrechen", () => cancelRemoveKey(k.name), { disabled: busy }),
      ]),
    ]);
  }

  function keyRow(k) {
    const keys = state.keys;
    const editable = canEditKey(k);
    const locked = k.locked === true;
    const head = h("div", { className: "settings-key-head" }, [
      h("span", { className: "settings-key-name", text: k.name }),
      h("span", { className: "settings-key-state", text: keyStateText(k) }),
    ]);
    const children = [head];
    if (typeof k.description === "string" && k.description) children.push(h("p", { className: "settings-key-desc", text: k.description }));
    const notes = [];
    if (locked) notes.push(KEYS_TEXT.locked);
    if (k.restartPending === true) notes.push(KEYS_TEXT.pending);
    if (notes.length) children.push(h("p", { className: "settings-key-desc settings-key-note", text: notes.join(" · ") }));
    const ed = keys.editors.get(k.name);
    if (editable && ed) children.push(keyEditorNode(k, ed));
    else if (editable && keys.confirm === k.name) children.push(keyConfirmNode(k));
    else if (editable) {
      const actions = [keyButton("key-edit:" + k.name, k.set === true ? "Ersetzen" : "Setzen", () => openKeyEditor(k.name))];
      if (k.set === true) actions.push(keyButton("key-remove:" + k.name, "Entfernen", () => askRemoveKey(k.name)));
      children.push(h("div", { className: "settings-actions settings-key-actions" }, actions));
    }
    const row = keys.rows.get(k.name);
    if (row) {
      children.push(h("p", {
        className: row.kind === "error" ? "actions-error" : "settings-status",
        role: row.kind === "error" ? "alert" : "status",
        text: row.text,
      }));
    }
    return h("li", {
      "data-key": k.name,
      "data-set": k.set === true ? "true" : "false",
      "data-locked": locked ? "true" : null,
    }, children);
  }

  function keysRestartNode() {
    const f = state.keys;
    if (!f.restart) return null;
    const box = h("div", { className: "settings-restart settings-keys-restart" }, [h("p", { className: "actions-hint", text: KEYS_TEXT.restartNote })]);
    if (f.restart.status !== "done") {
      box.appendChild(keyButton("key-restart", f.restart.status === "busy" ? "Wird angefordert …" : "Jetzt neu starten", () => void restart(f), { strong: true, disabled: f.restart.status === "busy" }));
    }
    if (f.restart.message) {
      box.appendChild(h("p", {
        className: f.restart.status === "failed" ? "actions-error" : "settings-status",
        role: f.restart.status === "failed" ? "alert" : "status",
        text: f.restart.message,
      }));
    }
    return box;
  }

  function keysPanel() {
    const k = state.keys;
    const refresh = keyButton("keys-refresh", k.loading ? "Lädt …" : "Aktualisieren", () => void loadKeys(), { disabled: k.loading });
    if (!k.data) {
      if (k.phase === "failed") return [h("p", { className: "actions-error", role: "alert", text: k.error || KEYS_TEXT.loadFailed }), refresh];
      return [h("p", { className: "settings-empty", text: "Lädt …" })];
    }
    const nodes = [];
    if (k.error) {
      nodes.push(h("div", { className: "settings-sync" }, [
        h("p", { className: "actions-error", role: "alert", text: k.error + " " + SETTINGS_TEXT.showingLast }),
      ]));
    }
    nodes.push(h("div", { className: "settings-actions settings-status-head" }, [h("p", { className: "settings-intro", text: KEYS_TEXT.intro }), refresh]));
    if (k.data.editAllowed !== true) nodes.push(h("p", { className: "settings-keys-readonly", role: "note", text: keysReadOnlyText(k.data) }));
    const restartBox = keysRestartNode();
    if (restartBox) nodes.push(restartBox);
    const groups = new Map();
    for (const key of keyList()) {
      const group = typeof key.group === "string" && key.group ? key.group : "Weitere";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(key);
    }
    for (const [group, list] of groups) {
      const ul = h("ul", { className: "settings-keys settings-keys-edit", "aria-label": group });
      for (const key of list) ul.appendChild(keyRow(key));
      const hints = list.some(x => x.locked === true) ? [KEYS_TEXT.lockedNote] : [];
      nodes.push(sectionNode("keys-" + group, group, hints, [ul]));
    }
    return nodes;
  }

  // --- Anzeige „Status" -----------------------------------------------------------

  function fact(term, value) {
    return [h("dt", { text: term }), h("dd", { text: value })];
  }

  function formatStarted(iso) {
    const date = new Date(String(iso || ""));
    if (isNaN(date.getTime())) return null;
    const two = n => String(n).padStart(2, "0");
    return two(date.getDate()) + "." + two(date.getMonth() + 1) + "., " + two(date.getHours()) + ":" + two(date.getMinutes()) + " Uhr";
  }

  function intakeFact(v) {
    if (!v || typeof v !== "object" || typeof v.state !== "string") return [];
    if (v.state === "ok") return [fact("Telegram-Eingang", "läuft")];
    const known = v.state === "conflict" || v.state === "unauthorized" || v.state === "other";
    const text = known && typeof v.message === "string" && v.message ? v.message : "unbekannt";
    return [fact("Telegram-Eingang", text)];
  }

  function statusFacts(d) {
    const version = d.version && typeof d.version === "object" ? d.version : {};
    const supervisor = d.supervisor === "launchd" ? "launchd" : d.supervisor === "pm2" ? "PM2" : d.supervisor === "systemd" ? "systemd" : d.supervisor === null ? "keiner" : "unbekannt";
    const storage = { supabase: "Supabase", none: "keiner" }[d.storage] || "unbekannt";
    const running = d.running && typeof d.running === "object" ? d.running : {};
    const count = v => (typeof v === "number" && isFinite(v) ? String(v) : "unbekannt");
    const started = formatStarted(d.startedAt);
    const list = h("dl", { className: "settings-facts" });
    const rows = [
      fact("Version", String(version.app || "unbekannt") + (typeof version.commit === "string" && version.commit ? " (" + version.commit + ")" : "")),
      fact("Laufzeit", formatUptime(d.uptimeSeconds) + (started ? ", seit " + started : "")),
      fact("Supervisor", supervisor),
      fact("Speicher", storage),
      // Nur mit Supabase: „aktiv" erst nach bestandenem Nachweis (tybo setup suche)
      ...(d.storage === "supabase" ? [fact("Semantische Suche", d.semanticSearch === "aktiv" ? "aktiv" : d.semanticSearch === "textsuche" ? "nur Textsuche" : "unbekannt")] : []),
      fact("Sessions", formatSessions(d.sessions)),
      // Getrennt, nicht addiert: eine Antwort kann in beiden Zählern stecken
      fact("Ausführungen (laufend und wartend)", count(running.executions)),
      fact("Claude-Aufrufe", count(running.claudeCalls)),
      fact("Neustart angefordert", d.restartRequested === true ? "ja" : d.restartRequested === false ? "nein" : "unbekannt"),
      // Telegram-Eingang (Issue #562): nur mit Zustand; bei 401, 409 und Störung die Meldung aus dem Log
      ...intakeFact(d.telegramIntake),
    ];
    for (const [dt, dd] of rows) {
      list.appendChild(dt);
      list.appendChild(dd);
    }
    return list;
  }

  /** Schlüssel nur als Name und „gesetzt"/„fehlt"; andere Felder der Antwort werden nie gezeigt */
  function keysSection(keys) {
    const groups = new Map();
    for (const k of Array.isArray(keys) ? keys : []) {
      if (!k || typeof k.name !== "string") continue;
      const group = typeof k.group === "string" && k.group ? k.group : "Sonstige";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ name: k.name, set: k.set === true });
    }
    const children = [];
    for (const [group, list] of groups) {
      const ul = h("ul", { className: "settings-keys", "aria-label": group });
      for (const k of list) {
        ul.appendChild(h("li", { "data-set": k.set ? "true" : "false" }, [
          h("span", { className: "settings-key-name", text: k.name }),
          h("span", { className: "settings-key-state", text: k.set ? "gesetzt" : "fehlt" }),
        ]));
      }
      children.push(h("p", { className: "settings-group-label", text: group }), ul);
    }
    return sectionNode("keys", "Schlüssel", [SETTINGS_TEXT.keysNote], children);
  }

  /** Motoren (Issue #126): je Motor installiert, angemeldet, Version; nur diese Felder */
  function engineStatusSection(engines) {
    if (!Array.isArray(engines)) return sectionNode("engines", "Motoren", [], [h("p", { className: "actions-hint", text: "unbekannt" })]);
    const ul = h("ul", { className: "settings-keys settings-engines", "aria-label": "Motoren" });
    for (const a of engines) {
      if (!a || typeof a.engine !== "string") continue;
      const ready = a.installed === true && a.loggedIn === true;
      ul.appendChild(h("li", { "data-set": ready ? "true" : "false", "data-engine": a.engine }, [
        h("span", { className: "settings-key-name", text: typeof a.label === "string" ? a.label : a.engine }),
        h("span", { className: "settings-key-state", text: engineAvailabilityText(a) }),
      ]));
    }
    return sectionNode("engines", "Motoren", [], [ul]);
  }

  function restartSection() {
    const flow = state.restartFlow;
    const nodes = [];
    const button = (key, text, handler, strong, disabled) => {
      const b = h("button", { type: "button", className: strong ? "quiet-button action-confirm" : "quiet-button", "data-focus-key": key, disabled, text });
      b.addEventListener("click", handler);
      return b;
    };
    if (flow.step === "confirm" || flow.step === "busy") {
      nodes.push(h("p", { className: "actions-question", text: SETTINGS_TEXT.restartQuestion }));
      nodes.push(h("p", { className: "actions-hint", text: SETTINGS_TEXT.restartExplain }));
      nodes.push(h("div", { className: "settings-actions" }, [
        button("status-restart-yes", flow.step === "busy" ? "Wird angefordert …" : "Neu starten", () => void confirmRestart(), true, flow.step === "busy"),
        button("status-restart-no", "Abbrechen", cancelRestart, false, flow.step === "busy"),
      ]));
    } else if (flow.step === "waiting") {
      if (flow.message) nodes.push(h("p", { className: "actions-hint", text: flow.message }));
      nodes.push(h("p", { className: "settings-status", role: "status", text: flow.lost ? SETTINGS_TEXT.restartLost : SETTINGS_TEXT.restartWaiting }));
    } else {
      if (flow.message) {
        nodes.push(h("p", {
          className: flow.step === "failed" ? "actions-error" : "settings-status",
          role: flow.step === "failed" ? "alert" : "status",
          text: flow.message,
        }));
      }
      nodes.push(h("p", { className: "actions-hint", text: window.TYBO_BRAND.name + " startet nach der laufenden Antwort neu, nie mitten in einer Antwort." }));
      nodes.push(h("div", { className: "settings-actions" }, [button("status-restart", "Jetzt neu starten", askRestart, true, false)]));
    }
    return sectionNode("restart", "Neustart", [], nodes);
  }

  /** Letzter Exit-Code: 0 ok, sonst Fehler, null unbekannt */
  function routineExitText(code) {
    if (typeof code !== "number" || !isFinite(code)) return "unbekannt";
    return code === 0 ? "ok" : "Fehler (Exit " + code + ")";
  }

  const pad2 = n => String(n).padStart(2, "0");
  const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

  /** „heute 06:30", „gestern 06:30", „morgen 06:30", sonst „Mo 19.10. 06:30"; Ortszeit des Browsers */
  function routineWhen(iso) {
    const d = new Date(iso);
    if (!isFinite(d.getTime())) return "Zeit unbekannt";
    const now = new Date();
    const day = x => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
    const diff = Math.round((day(d) - day(now)) / 86400000);
    const time = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    if (diff === 0) return "heute " + time;
    if (diff === -1) return "gestern " + time;
    if (diff === 1) return "morgen " + time;
    return WEEKDAY_SHORT[d.getDay()] + " " + d.getDate() + "." + (d.getMonth() + 1) + "." + (d.getFullYear() === now.getFullYear() ? "" : d.getFullYear()) + " " + time;
  }

  /** Dauer wie durationText in src/lib/routines/format.ts */
  function routineDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 1000) return "unter 1 s";
    const total = Math.round(ms / 1000);
    if (total < 60) return total + " s";
    if (total < 3600) return Math.floor(total / 60) + " min" + (total % 60 ? " " + (total % 60) + " s" : "");
    const m = Math.floor((total % 3600) / 60);
    return Math.floor(total / 3600) + " h" + (m ? " " + m + " min" : "");
  }

  function routineRunFailed(run) {
    return run.exitCode !== 0 || !!run.signal;
  }

  function routineRunResult(run) {
    return run.signal ? "abgebrochen (" + run.signal + ")" : routineExitText(run.exitCode);
  }

  function routineRunText(run) {
    return routineWhen(run.startedAt) + ", " + routineDuration(run.durationMs) + ", " + routineRunResult(run);
  }

  /** Nächster Lauf wie nextRunText in src/lib/routines/format.ts; null: Zeitplan kennt keinen */
  function routineNextText(r) {
    if (r.kind === "daemon") return null;
    if (r.state === "paused") return "keiner (pausiert)";
    if (r.state === "not-loaded") return "keiner (nicht geladen)";
    if (typeof r.nextRun === "string") {
      const t = Date.parse(r.nextRun);
      if (isFinite(t)) return t <= Date.now() ? "fällig seit " + routineWhen(r.nextRun) : routineWhen(r.nextRun);
    }
    return r.state === "unknown" ? "unbekannt" : null;
  }

  /** Zeitplan, letzter Lauf (bzw. letzter Exit ohne Wrapper) und nächster Lauf */
  function routineMeta(r) {
    if (r.kind === "daemon") return "letzter Exit: " + routineExitText(r.lastExit);
    const parts = [String(r.scheduleText || "")];
    if (r.wrapped !== true) parts.push("letzter Exit: " + routineExitText(r.lastExit), ROUTINES_TEXT.notWrapped);
    else parts.push("letzter Lauf: " + (r.lastRun && typeof r.lastRun === "object" ? routineRunText(r.lastRun) : ROUTINES_TEXT.noRunYet));
    const next = routineNextText(r);
    if (next) parts.push("nächster Lauf: " + next);
    return parts.join(" · ");
  }

  /** Verlauf unter der aufgeklappten Routine: Läufe neueste oben, beim neuesten Fehler Ausgabe und Log-Pfad */
  function routineHistory(r) {
    const v = state.routines.runs;
    const id = "settings-routine-runs-" + String(r.id).replace(/[^A-Za-z0-9_-]/g, "-");
    const children = routineActions(r);
    if (v.id !== r.id || v.phase === "loading" || v.phase === "idle") children.push(h("p", { className: "settings-empty", text: ROUTINES_TEXT.runsLoading }));
    else if (v.phase === "failed") children.push(h("p", { className: "actions-error", role: "alert", text: v.error || ROUTINES_TEXT.runsFailed }));
    else {
      const runs = v.data.runs.filter(x => x && typeof x.startedAt === "string" && typeof x.exitCode === "number");
      if (r.wrapped !== true) children.push(h("p", { className: "actions-hint", text: "Verlauf: " + ROUTINES_TEXT.notWrapped + "." }));
      if (!runs.length) {
        if (r.wrapped === true) children.push(h("p", { className: "settings-empty settings-routine-runs-empty", text: ROUTINES_TEXT.noRuns }));
      } else {
        const ul = h("ol", { className: "settings-routine-runs", "aria-label": "Letzte Läufe, neueste oben" });
        for (const run of runs) ul.appendChild(h("li", { "data-ok": routineRunFailed(run) ? "false" : "true", text: routineRunText(run) }));
        children.push(ul);
        const latest = runs[0];
        if (routineRunFailed(latest)) {
          const tail = Array.isArray(latest.tail) ? latest.tail.filter(l => typeof l === "string") : [];
          if (tail.length) {
            children.push(h("p", { className: "actions-hint", text: ROUTINES_TEXT.tail + " (" + routineWhen(latest.startedAt) + "):" }));
            children.push(h("pre", { className: "settings-routine-tail", text: tail.join("\n") }));
          } else children.push(h("p", { className: "actions-hint", text: ROUTINES_TEXT.noTail }));
          if (typeof latest.logPath === "string" && latest.logPath) children.push(h("p", { className: "actions-hint settings-routine-log", text: "Log: " + latest.logPath }));
        }
      }
    }
    return h("div", { className: "settings-routine-history", id, role: "region", "aria-label": "Verlauf " + String(r.name) }, children);
  }

  /** Eine Routine: Name, darunter Zeitplan, letzter und nächster Lauf, rechts der Status. Zeitgesteuerte klappen ihren Verlauf auf */
  function routineRow(r) {
    const daemon = r.kind === "daemon";
    const state_ = ROUTINE_STATE_TEXT[r.state] || ROUTINE_STATE_TEXT.unknown;
    const fine = r.state === "active" || r.state === "running";
    const open = !daemon && state.routines.openId === r.id;
    const label = [
      h("span", { className: "settings-routine-name", text: String(r.name) }),
      h("span", { className: "settings-device-meta", text: routineMeta(r) }),
    ];
    const head = daemon
      ? h("span", { className: "settings-device-name" }, label)
      : h(
          "button",
          {
            type: "button",
            className: "settings-device-name settings-routine-open",
            "aria-expanded": open ? "true" : "false",
            "aria-controls": open ? "settings-routine-runs-" + String(r.id).replace(/[^A-Za-z0-9_-]/g, "-") : null,
            "data-focus-key": "routine-" + String(r.id),
          },
          label
        );
    if (!daemon) head.addEventListener("click", () => toggleRoutine(r.id));
    const children = [head, h("span", { className: "settings-routine-state", text: state_ })];
    if (open) children.push(routineHistory(r));
    return h("li", { "data-routine": String(r.id), "data-state": String(r.state), "data-ok": fine ? "true" : "false", "data-open": open ? "true" : "false" }, children);
  }

  /** Eine offene Erinnerung: Zeit und Text, darunter Ort, Wiederholung, Zustand; rechts „Absagen" */
  function reminderRow(x) {
    const r = state.reminders;
    const mine = r.act.id === x.id;
    const meta = [String(x.place || "")];
    if (x.recurrence) meta.push(String(x.recurrence));
    if (x.status === "running") meta.push(REMINDERS_TEXT.sending);
    else if (x.overdue === true) meta.push(REMINDERS_TEXT.overdue);
    meta.push("Kennung " + String(x.ref || ""));
    const button = (key, text, handler, strong, disabled) => {
      const b = h("button", { type: "button", className: strong ? "quiet-button action-confirm" : "quiet-button", "data-focus-key": key, disabled, text });
      b.addEventListener("click", handler);
      return b;
    };
    const children = [
      h("span", { className: "settings-device-name" }, [
        h("span", { className: "settings-reminder-text", text: String(x.dueText || "") + " · " + String(x.text || "") }),
        h("span", { className: "settings-device-meta", text: meta.filter(Boolean).join(" · ") }),
      ]),
    ];
    if (mine && r.act.step !== "idle") {
      const busy = r.act.step === "busy";
      children.push(h("div", { className: "settings-routine-confirm settings-reminder-confirm", role: "group", "aria-label": REMINDERS_TEXT.cancel }, [
        h("p", { className: "actions-question", text: REMINDERS_TEXT.confirmQuestion(String(x.text || "")) }),
        x.recurrence ? h("p", { className: "actions-hint", text: REMINDERS_TEXT.confirmSeries }) : null,
        h("div", { className: "settings-actions" }, [
          button("reminder-cancel-yes", busy ? REMINDERS_TEXT.busy : REMINDERS_TEXT.confirmYes, () => void cancelReminder(x.id), true, busy),
          button("reminder-cancel-no", "Abbrechen", dropCancelReminder, false, busy),
        ]),
      ]));
    } else {
      // Während des Versands lässt sich nichts absagen (wie /erinnerungen)
      children.push(button("reminder-" + String(x.id), REMINDERS_TEXT.cancel, () => askCancelReminder(x.id), false, x.status === "running" || r.act.step === "busy"));
    }
    return h("li", { "data-reminder": String(x.id), "data-status": x.status === "running" ? "running" : "pending" }, children);
  }

  function remindersPanel() {
    const r = state.reminders;
    const refresh = h("button", {
      type: "button",
      className: "quiet-button",
      "data-focus-key": "reminders-refresh",
      disabled: !!r.loading,
      text: r.loading ? "Lädt …" : "Aktualisieren",
    });
    refresh.addEventListener("click", () => {
      r.message = null;
      void loadReminders();
    });
    if (!r.data) {
      if (r.phase === "failed") return [h("p", { className: "actions-error", role: "alert", text: r.error || REMINDERS_TEXT.failed }), refresh];
      return [h("p", { className: "settings-empty", text: "Lädt …" })];
    }
    const nodes = [];
    if (r.error) nodes.push(h("div", { className: "settings-sync" }, [h("p", { className: "actions-error", role: "alert", text: r.error + " " + SETTINGS_TEXT.showingLast })]));
    nodes.push(h("div", { className: "settings-actions settings-status-head" }, [h("p", { className: "settings-intro", text: REMINDERS_TEXT.intro }), refresh]));
    if (r.message) nodes.push(h("p", { className: r.failed ? "actions-error settings-reminders-message" : "settings-status settings-reminders-message", role: r.failed ? "alert" : "status", text: r.message }));
    const items = r.data.reminders.filter(x => x && typeof x.id === "string");
    if (!items.length) nodes.push(h("p", { className: "settings-empty settings-reminders-empty", text: REMINDERS_TEXT.none }));
    else {
      const ul = h("ul", { className: "settings-devices settings-reminders", "aria-label": "Offene Erinnerungen" });
      for (const x of items) ul.appendChild(reminderRow(x));
      nodes.push(ul);
    }
    return nodes;
  }

  function routinesPanel() {
    const r = state.routines;
    const refresh = h("button", {
      type: "button",
      className: "quiet-button",
      "data-focus-key": "routines-refresh",
      disabled: !!r.loading,
      text: r.loading ? "Lädt …" : "Aktualisieren",
    });
    refresh.addEventListener("click", () => void loadRoutines());
    if (!r.data) {
      if (r.phase === "failed") return [h("p", { className: "actions-error", role: "alert", text: r.error || ROUTINES_TEXT.failed }), refresh];
      return [h("p", { className: "settings-empty", text: "Lädt …" })];
    }
    const nodes = [];
    if (r.error) nodes.push(h("div", { className: "settings-sync" }, [h("p", { className: "actions-error", role: "alert", text: r.error + " " + SETTINGS_TEXT.showingLast })]));
    nodes.push(h("div", { className: "settings-actions settings-status-head" }, [h("p", { className: "settings-intro", text: ROUTINES_TEXT.intro }), refresh]));
    const d = r.data;
    if (d.available !== true) {
      nodes.push(h("p", { className: "settings-empty settings-routines-unavailable", text: ROUTINES_TEXT.unavailable }));
      return nodes;
    }
    const all = Array.isArray(d.routines) ? d.routines.filter(x => x && typeof x.id === "string" && typeof x.name === "string") : [];
    const scheduled = all.filter(x => x.kind !== "daemon");
    const daemons = all.filter(x => x.kind === "daemon");
    if (!all.length) nodes.push(h("p", { className: "settings-empty settings-routines-empty", text: ROUTINES_TEXT.none }));
    if (scheduled.length) {
      const ul = h("ul", { className: "settings-devices settings-routines", "aria-label": "Zeitgesteuert" });
      for (const x of scheduled) ul.appendChild(routineRow(x));
      nodes.push(ul);
    }
    if (daemons.length) {
      const open = r.daemonsOpen;
      const toggle = h("button", {
        type: "button",
        className: "quiet-button settings-routines-toggle",
        "aria-expanded": open ? "true" : "false",
        "aria-controls": "settings-routines-daemons",
        "data-focus-key": "routines-daemons",
        text: (open ? "Dauerdienste ausblenden" : "Dauerdienste anzeigen") + " (" + daemons.length + ")",
      });
      toggle.addEventListener("click", () => {
        r.daemonsOpen = !r.daemonsOpen;
        render();
      });
      const children = [toggle];
      if (open) {
        const ul = h("ul", { className: "settings-devices settings-routines", id: "settings-routines-daemons", "aria-label": ROUTINES_TEXT.daemons });
        for (const x of daemons) ul.appendChild(routineRow(x));
        children.push(ul);
      }
      nodes.push(sectionNode("routines-daemons", ROUTINES_TEXT.daemons, [], children));
    }
    const hints = [];
    for (const note of Array.isArray(d.notes) ? d.notes : []) if (typeof note === "string" && note) hints.push(h("p", { className: "actions-hint", text: note }));
    if (d.source === "launchd") hints.push(h("p", { className: "actions-hint", text: ROUTINES_TEXT.ownHint }));
    if (ROUTINES_TEXT.pending) hints.push(h("p", { className: "actions-hint", text: ROUTINES_TEXT.pending }));
    nodes.push(h("div", { className: "settings-routines-hints" }, hints));
    return nodes;
  }

  function statusPanel() {
    const st = state.status;
    const refresh = h("button", {
      type: "button",
      className: "quiet-button",
      "data-focus-key": "status-refresh",
      disabled: !!st.loading,
      text: st.loading ? "Lädt …" : "Aktualisieren",
    });
    refresh.addEventListener("click", () => void loadStatus());
    if (!st.data) {
      if (st.phase === "failed") return [h("p", { className: "actions-error", role: "alert", text: st.error || SETTINGS_TEXT.statusFailed }), refresh];
      return [h("p", { className: "settings-empty", text: "Lädt …" })];
    }
    const nodes = [];
    // Letzte Abfrage gescheitert: angezeigt ist der vorige Stand (auch während des Neustarts)
    if (st.error && state.restartFlow.step !== "waiting") {
      nodes.push(h("div", { className: "settings-sync" }, [
        h("p", { className: "actions-error", role: "alert", text: st.error + " " + SETTINGS_TEXT.showingLast }),
      ]));
    }
    nodes.push(
      h("div", { className: "settings-actions settings-status-head" }, [
        h("p", { className: "settings-intro", text: "Zustand von " + window.TYBO_BRAND.name + ", wie er gerade läuft." }),
        refresh,
      ]),
      statusFacts(st.data),
      engineStatusSection(st.data.engines),
      keysSection(st.data.keys),
      restartSection()
    );
    return nodes;
  }

  function renderPanel() {
    el.notice.hidden = true;
    el.notice.textContent = "";
    if (state.tab === "benachrichtigungen" && pushSettings) {
      el.panel.replaceChildren(...pushSettings.nodes());
      return;
    }
    if (state.tab === "status") {
      el.panel.replaceChildren(...statusPanel());
      return;
    }
    if (state.tab === "routinen") {
      el.panel.replaceChildren(...routinesPanel());
      return;
    }
    if (state.tab === "erinnerungen") {
      el.panel.replaceChildren(...remindersPanel());
      return;
    }
    if (state.tab === "schluessel") {
      el.panel.replaceChildren(...keysPanel());
      return;
    }
    if (!state.data) {
      if (isStale()) el.panel.replaceChildren(...syncFailedNodes());
      else if (state.loading) el.panel.replaceChildren(h("p", { className: "settings-empty", text: "Lädt …" }));
      else el.panel.replaceChildren();
      return;
    }
    if (state.data.fileInvalid) {
      el.notice.textContent = SETTINGS_TEXT.fileInvalid;
      el.notice.hidden = false;
    }
    // Vorhandene Formulare und Eingaben bleiben, der Stand ist aber als unbestätigt gekennzeichnet
    const failed = isStale() ? [h("div", { className: "settings-sync" }, syncFailedNodes())] : [];
    if (state.tab === "modelle") {
      el.panel.replaceChildren(...failed, ...modelsPanel());
      return;
    }
    if (state.tab === "sprechen") {
      el.panel.replaceChildren(...failed, ...speechPanel());
      return;
    }
    const list = h("ul", { className: "settings-agents" });
    for (const name of agentNames()) list.appendChild(agentRow(name));
    const catalogReady = !!state.catalog.data;
    el.panel.replaceChildren(...[
      ...failed,
      ...catalogProblemNodes(),
      // Motor oben (Issue #126): Standard, Codex, abweichende Gespräche
      engineSection(),
      h("p", { className: "settings-intro", text: "System-Prompt, Modell, Effort und zusätzliche Anweisungen je Agent. Modell und Effort gelten für Claude Code. Speichern gilt pro Agent." }),
      agentNoticeNode(),
      catalogReady ? createSection() : null,
      list,
      catalogReady ? deletedSection() : null,
    ].filter(Boolean));
  }

  function render() {
    if (!state.open) return;
    const focused = focusedKey();
    renderTabs();
    renderPanel();
    if (focused) focusKey(focused);
  }

  // --- Öffnen und Schließen ----------------------------------------------------

  function show(tab) {
    const wasOpen = state.open;
    const previousTab = state.tab;
    state.open = true;
    state.tab = SETTINGS_TABS.some(t => t.id === tab && t.ready) ? tab : "agenten";
    el.view.hidden = false;
    if (state.tab !== "status") stopStatusPoll();
    // Schlüssel: beim Verlassen Felder leeren, beim Öffnen frisch laden (Issue #63)
    if (state.tab !== "schluessel" || !wasOpen) closeAllKeyEditors();
    if (state.tab === "schluessel" && (!wasOpen || previousTab !== "schluessel")) {
      state.keys.rows.clear();
      void loadKeys();
    }
    // Sprechen (Issue #248): Status des Sprechmodus bei jedem Öffnen des Reiters frisch
    if (state.tab === "sprechen" && (!wasOpen || previousTab !== "sprechen")) {
      void loadVoice();
      // Stimmen des Browsers können später eintreffen (Issue #250)
      if (speechDevice) speechDevice.open();
      if (voiceClone) voiceClone.open();
    }
    // Reiter „Sprechen" verlassen (Issue #253): Mikrofon frei, eine Aufnahme verworfen
    if (state.tab !== "sprechen" && voiceClone) voiceClone.close();
    // Benachrichtigungen (Issue #225): Geräte und Abo bei jedem Öffnen des Reiters frisch
    if (state.tab === "benachrichtigungen" && pushSettings && (!wasOpen || previousTab !== "benachrichtigungen")) pushSettings.open();
    // Routinen (Issue #284) bei jedem Öffnen des Reiters frisch
    if (state.tab === "routinen" && (!wasOpen || previousTab !== "routinen")) void loadRoutines();
    // Erinnerungen (Issue #323) bei jedem Öffnen des Reiters frisch, ohne alte Meldung
    if (state.tab === "erinnerungen" && (!wasOpen || previousTab !== "erinnerungen")) {
      state.reminders.message = null;
      state.reminders.act = { id: null, step: "idle" };
      void loadReminders();
    }
    // Status bei jedem Öffnen des Reiters frisch; wartet ein Neustart, geht das Nachfragen weiter
    if (state.tab === "status" && (!wasOpen || previousTab !== "status")) {
      void loadStatus().then(() => scheduleStatusPoll());
    }
    // Bei jedem Öffnen frisch laden (in Telegram per /agent geändert, andere Browser)
    if (!wasOpen) {
      void load();
      // Motor (Issue #126): Verfügbarkeit und Ausnahmen bei jedem Öffnen frisch
      state.engines.notice = null;
      state.engines.rowError = null;
      void loadEngines();
      state.agentNotice = null;
      void loadCatalog();
      // Prompts wie die Anweisungen; ein offener Entwurf bleibt stehen (Issue #51)
      for (const [name, p] of state.prompts) {
        p.confirmReset = false;
        if (state.expanded.has(name)) void loadPrompt(name);
        else {
          p.seq++;
          if (!p.editing) p.status = "idle";
        }
      }
      // Eine Löschrückfrage nennt Topics von damals: neu fragen lassen
      for (const r of state.removals.values()) {
        if (r.step === "busy") continue;
        r.seq++;
        r.step = "idle";
        r.input = "";
        r.error = null;
      }
      // Anweisungen ebenso: aufgeklappte sofort, die übrigen beim Aufklappen
      for (const [name, i] of state.instructions) {
        i.confirm = false;
        if (state.expanded.has(name)) void loadInstructions(name);
        else {
          // Eine noch laufende ältere Antwort wird verworfen
          i.seq++;
          i.status = "idle";
        }
      }
    } else render();
  }

  function hide() {
    state.open = false;
    // Eigene Stimme (Issue #253): kein Mikrofon bei geschlossenen Einstellungen
    if (voiceClone) voiceClone.close();
    stopStatusPoll();
    if (state.restartFlow.step === "confirm") state.restartFlow.step = "idle";
    closeAllKeyEditors();
    el.view.hidden = true;
  }

  /**
   * Neu laden (Issue #111): Geht beim Neuladen etwas verloren? Geänderte
   * Formulare, offene Editoren (Prompt, Anweisung, neuer Agent, Schlüssel)
   * und laufende Speichervorgänge. Im Zweifel ja.
   */
  function hasUnsavedChanges() {
    for (const [name, f] of state.forms) if (f.saving || isDirty(name)) return true;
    for (const [section, g] of state.globals) if (g.saving || isGlobalDirty(section)) return true;
    for (const p of state.prompts.values()) if (p.editing || p.busy) return true;
    for (const i of state.instructions.values()) if (i.busy || (typeof i.text === "string" && i.text.trim())) return true;
    for (const b of state.boards.values()) if (b.busy) return true;
    if (state.creating) return true;
    if (state.engines.resetting) return true;
    if (state.keys.editors.size || state.keys.pending.size) return true;
    if (pushSettings && pushSettings.isBusy()) return true;
    if (voiceClone && voiceClone.isBusy()) return true;
    return false;
  }

  return { show, hide, isOpen: () => state.open, hasUnsavedChanges };
}
