/**
 * Wizard für Sprachagenten, Serverteil (Issue #514): Pfade, Texte und
 * Schnittstelle, ohne Importe aus src/lib (wie ./voice-agent-admin.ts). Die
 * Umsetzung steht in ./bot-voice-agent-wizard.ts und kommt über die
 * Abhängigkeit voiceAgentWizard herein; die Oberfläche baut SA1-10.
 *
 * API (alles hinter Login und Origin-Prüfung; Lesen auch mit dem
 * Terminal-Schlüssel, Ändern nur im Browser):
 * - POST /api/voice-agents/wizard/vorschlag { satz } → { vorschlag: { kennung,
 *   felder, feste }, quelle: "modell" | "leer", hinweis? }. Nebenmodell
 *   voice-wizard, höchstens 20 Sekunden; scheitert es, leere Felder mit Vorlage
 *   experte. Höchstens 10 Vorschläge in 10 Minuten und einer zur Zeit, sonst
 *   429 mit Retry-After.
 * - GET /api/voice-agents/wizard/entwuerfe → { entwuerfe: [...], beendet: [...] }:
 *   offene Entwürfe des Wizards, zuletzt geändert zuerst, je mit schritt zum
 *   Fortsetzen; unter beendet fertige und abgebrochene der letzten sieben Tage
 *   (Issue #515), damit sich ihr Ergebnis wieder öffnen lässt.
 * - GET /api/voice-agents/wizard/<kennung> → Entwurf mit felder, feste,
 *   anhaenge, revision, phase, kosten und stimme. 404 ohne Wizard-Entwurf
 *   dieser Kennung. Dazu festeRegeln (Issue #515, auch im Vorschlag): die
 *   festen Regeln je Vorlage, damit die Oberfläche eigene Regeln auch nach
 *   einem Vorlagenwechsel zusammen mit den passenden festen zurückschickt.
 * - PUT /api/voice-agents/wizard/<kennung> { revision?, satz?, schritt?, felder, offen? }: ohne
 *   revision legt er an (201, reserviert die Kennung), mit revision speichert
 *   er (200). Veraltete revision oder schon gebaut: 409. Falsche Form: 400.
 *   Feste Regel geändert oder abgeschaltet: 422. offen (Prüfung von PR #558)
 *   sind unfertige Eingaben ({ links?, telefon? }), getrennt von felder
 *   gespeichert und im Entwurf zurückgegeben; jedes Speichern ersetzt sie,
 *   Bauen lehnt mit 422 ab, solange davon etwas offen ist.
 * - DELETE /api/voice-agents/wizard/<kennung>: verwirft einen noch nicht
 *   gebauten Entwurf und gibt die Kennung frei.
 * - POST /api/voice-agents/wizard/<kennung>/anhaenge (Rohdaten, Name in
 *   x-file-name): PDF, Text oder Markdown; DELETE …/anhaenge/<datei>.
 * - POST /api/voice-agents/wizard/<kennung>/umbenennen { revision, kennung }
 *   (Issue #515): ändert vor dem Bauen die Kennung. Felder, Satz, Schritt und
 *   Anhänge ziehen mit um, die Antwort ist der Entwurf unter der neuen
 *   Kennung. Vergeben, belegt oder schon ein Wizard: 409, der Entwurf bleibt
 *   unter der alten Kennung, wie er war. Ungültige Kennung: 422.
 * - POST /api/voice-agents/wizard/<kennung>/bauen { revision } → 202 { entwurf }:
 *   derselbe Ablauf wie /sprachagent neu (Job, Prüfung, Nachbesserung,
 *   Stimmwahl und Freigabe als Rückfrage im Direktchat).
 * - GET /api/voice-agents/wizard/<kennung>/fortschritt → { phase, versuch, …,
 *   tests, rueckfrage, freigeschaltet, web } (Issue #515).
 * - GET /api/voice-agents/wizard/stimmen → { standard, konto, hinweis? }
 *   (Issue #515): Standardstimme ohne Kennung, Stimmen des Kontos beim Anbieter.
 * - POST /api/voice-agents/wizard/hoerprobe { voiceId } | { standard: true },
 *   dazu optional sprache (Kürzel aus zwei Buchstaben) → Audio (WAV): der
 *   KI-Hinweis dieser Sprache mit genau dieser Stimme. Nur Kennungen aus der
 *   Stimmenliste, kein Text vom Browser, Ton nie gespeichert, eigene Grenze
 *   (429 mit Retry-After), Zeitlimit 504, ohne Anbieter 503. Die Hörprobe des
 *   Telefonhörers (/api/voice/call/voice-probe) bleibt unverändert.
 */

export const VOICE_WIZARD_PATH = /^\/api\/voice-agents\/wizard\/([^/]+)(?:\/(bauen|fortschritt|anhaenge|umbenennen)(?:\/([^/]+))?)?$/;

/**
 * Wegsegmente eines Agenten mit der Kennung „wizard“ (Gespräch und
 * Verwaltung): Diese Pfade gehören weiter dem Agenten, nicht dem Wizard.
 */
const AGENT_SEGMENTS = new Set(["session", "rezept", "test", "link", "loeschen"]);

export type WizardAction = "" | "bauen" | "fortschritt" | "anhaenge" | "umbenennen";

export function matchWizardPath(path: string): { segment: string; action: WizardAction; datei?: string } | null {
  const m = VOICE_WIZARD_PATH.exec(path);
  if (!m || AGENT_SEGMENTS.has(m[1])) return null;
  return { segment: m[1], action: (m[2] ?? "") as WizardAction, ...(m[3] !== undefined ? { datei: m[3] } : {}) };
}

/** Grenze für einen Anhang des Wizards (PDF); Text höchstens 1 MB */
export const WIZARD_ATTACHMENT_MAX_BYTES = 10 * 1_048_576;

export const VOICE_WIZARD_TEXT = {
  notConfigured: "Den Wizard für Sprachagenten gibt es in diesem Prozess nicht.",
  browserOnly: "Den Wizard bedienst du nur im Browser.",
  invalid: "Ungültige Anfrage.",
  needSentence: "Bitte einen Satz angeben, höchstens 500 Zeichen.",
  rateLimited: "Zu viele Vorschläge in kurzer Zeit, bitte etwas warten.",
  busy: "Es läuft schon ein Vorschlag, bitte warten.",
  unknown: "Diesen Entwurf des Wizards gibt es nicht.",
  badKennung: "Ungültige Kennung: nur Kleinbuchstaben, Ziffern und einzelne Bindestriche, nicht session, rezept, test, link, loeschen, vorschlag, entwuerfe, stimmen oder hoerprobe.",
  taken: "Diese Kennung hat schon ein Sprachagent.",
  occupied: "Für diese Kennung ist schon ein anderer Entwurf offen.",
  stale: "Der Entwurf wurde inzwischen geändert. Bitte neu laden.",
  exists: "Diesen Entwurf gibt es schon. Zum Speichern revision mitschicken.",
  building: "Der Entwurf wird schon gebaut oder ist beendet und lässt sich nicht mehr ändern.",
  fixed: "Feste Regeln lassen sich nicht ändern oder abschalten.",
  shape: "Die Felder passen nicht.",
  incomplete: "Zum Bauen fehlen noch Angaben.",
  renameShape: "Erwartet { revision, kennung }.",
  buildOnly: "Bauen nimmt nur revision; Felder ändert PUT.",
  tooMany: "Es laufen schon drei Entwürfe, bitte warten.",
  attachmentType: "Erlaubt sind PDF, Text (.txt) und Markdown (.md).",
  attachmentLarge: "Datei zu groß: PDF höchstens 10 MB, Text höchstens 1 MB.",
  attachmentCount: "Höchstens 5 Anhänge je Entwurf.",
  attachmentUnknown: "Diesen Anhang gibt es nicht.",
  empty: "Die Datei ist leer.",
  badName: "Dateiname ist nicht gültig kodiert.",
  failed: "Das ist fehlgeschlagen, Details im Log.",
  probeNoProvider: "Für die Hörprobe fehlt der Zugang zum Anbieter (ELEVENLABS_API_KEY).",
  probeUnknownVoice: "Diese Stimme steht nicht in der Liste der Stimmen.",
  probeNoStandard: "Es ist keine Standardstimme eingestellt (Einstellungen, Sprache).",
  probeTooMany: "Zu viele Hörproben in kurzer Zeit, bitte etwas warten.",
  probeTimeout: "Die Hörprobe kam nicht rechtzeitig.",
  probeFailed: "Die Hörprobe ließ sich nicht erzeugen.",
  probeShape: "Erwartet { voiceId } oder { standard: true }, dazu optional sprache.",
  voicesEmpty: "Keine Stimmen des Kontos abrufbar, zur Wahl steht nur die Standardstimme.",
  voiceGone: "stimme: Diese Stimme gibt es im Konto beim Anbieter nicht (mehr). Bitte eine andere wählen.",
} as const;

export interface VoiceWizardResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Statt JSON: Ton der Hörprobe (Issue #515) */
  audio?: { bytes: Uint8Array; type: string };
}

/** Was die Umsetzung braucht; jede Methode liefert Status und JSON */
export interface VoiceWizardPort {
  propose(body: unknown): Promise<VoiceWizardResult>;
  list(): Promise<VoiceWizardResult>;
  get(kennung: string): Promise<VoiceWizardResult>;
  put(kennung: string, body: unknown): Promise<VoiceWizardResult>;
  remove(kennung: string): Promise<VoiceWizardResult>;
  /** Kennung vor dem Bauen ändern (Issue #515); body { revision, kennung } */
  rename(kennung: string, body: unknown): Promise<VoiceWizardResult>;
  build(kennung: string, body: unknown): Promise<VoiceWizardResult>;
  progress(kennung: string): Promise<VoiceWizardResult>;
  /** name: Anzeigename aus x-file-name; undefined ohne */
  addAttachment(kennung: string, name: string | undefined, bytes: Uint8Array): Promise<VoiceWizardResult>;
  removeAttachment(kennung: string, datei: string): Promise<VoiceWizardResult>;
  /** Stimmenliste (Issue #515) */
  voices(): Promise<VoiceWizardResult>;
  /** Hörprobe einer Stimme der Liste (Issue #515); bei Erfolg mit audio */
  probe(body: unknown): Promise<VoiceWizardResult>;
}
