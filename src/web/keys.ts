/**
 * Schlüssel-API der WebUI (Issue #62, M6): GET /api/keys, PUT und DELETE
 * /api/keys/<name>. Schutzregeln aus SPEC.md, Entscheidung 0003:
 *
 * - Werte gehen nur in eine Richtung. Antworten nennen „gesetzt" und bei
 *   langen Werten die letzten 4 Zeichen, nie mehr; gesperrte Variablen nicht
 *   einmal die.
 * - Lesen geht immer (angemeldet), Ändern nur mit WEB_ALLOW_KEY_EDIT=true.
 *   Der Schalter muss beim Start gesetzt gewesen sein und noch in der .env
 *   stehen: Einschalten wirkt ab dem Neustart, Ausschalten sofort.
 * - WEB_*, TELEGRAM_BOT_TOKEN und TELEGRAM_USER_ID sind immer gesperrt
 *   (isLockedKey), auch für Namen, die der Katalog nicht kennt.
 * - Unbekannte Namen nur im Format [A-Z][A-Z0-9_]{1,63}.
 * - Über den Cloudflare Tunnel nur lesen (Issue #99, Entscheidung 0014):
 *   Setzen und Löschen enden mit 403 und homeOnly, die Liste meldet
 *   editAllowed false mit readOnlyReason "tunnel". Das gilt pro Anfrage
 *   (KeyRequest), gleichzeitige Anfragen aus dem Heimnetz bleiben unberührt.
 * - Im Log stehen nur Namen, nie Werte; Fehler nur mit ihrem Namen.
 *
 * Gelesen wird der Stand der .env, nicht process.env: nach Setzen oder
 * Löschen ist der neue Stand sofort sichtbar, wirksam wird er erst nach
 * einem Neustart (restartPending). Das Schreiben erledigt der KeysPort, in
 * src/bot.ts createBotKeys aus ./bot-keys (src/lib/env-file.ts), in
 * web:dev und Demo createDemoKeys (nur im Speicher).
 */

import { BRAND } from "../brand";
import { envValueProblem } from "./env-rules";
import { catalogEntry, isLockedKey, isValidKeyName, KEY_CATALOG, OTHER_GROUP } from "./key-catalog";
import type { ApiResult } from "./settings";

export const KEY_EDIT_SWITCH = "WEB_ALLOW_KEY_EDIT";
/** Kürzere Werte zeigen keine letzten Zeichen, sonst wäre zu viel vom Wert zu sehen */
export const MIN_LENGTH_FOR_LAST4 = 12;

export interface KeysPort {
  /** Stand der .env-Datei (nicht process.env); fehlt sie, leer */
  read(): Promise<Record<string, string>>;
  set(name: string, value: string): Promise<void>;
  /** false: war nicht gesetzt, nichts geschrieben */
  remove(name: string): Promise<boolean>;
  /** Werte, mit denen der Prozess läuft; nur zum Vergleich für restartPending */
  running(): Record<string, string | undefined>;
  /** WEB_ALLOW_KEY_EDIT beim Start des Prozesses */
  editEnabledAtStart(): boolean;
}

export const KEYS_TEXT = {
  notConfigured: "Schlüssel sind nicht eingerichtet",
  invalidName: "Ungültiger Name. Erlaubt: Großbuchstaben, Ziffern und _, 2 bis 64 Zeichen, am Anfang ein Buchstabe",
  locked: "Diese Variable lässt sich nicht über die WebUI ändern. Bitte direkt in .env bearbeiten.",
  readOnly: `Schlüssel sind schreibgeschützt. Zum Ändern WEB_ALLOW_KEY_EDIT=true in .env setzen und ${BRAND.name} neu starten.`,
  homeOnly: "Schlüssel ändern geht nur im Heimnetz. Von unterwegs sind sie nur lesbar.",
  invalidRequest: "Ungültige Anfrage. Erwartet: { \"value\": \"...\" }",
  notSet: "Diese Variable ist nicht gesetzt",
  notReadable: ".env ist nicht lesbar",
  notSaved: "Die Änderung konnte nicht gespeichert werden, .env ist unverändert",
  saved: "Gespeichert. Wirksam nach einem Neustart.",
  removed: "Gelöscht. Wirksam nach einem Neustart.",
} as const;

export interface KeyInfo {
  name: string;
  group: string;
  description: string | null;
  set: boolean;
  /** Letzte 4 Zeichen, nur bei änderbaren Variablen mit langen Werten */
  last4: string | null;
  editable: boolean;
  /** Nie über die WebUI änderbar (isLockedKey), unabhängig vom Opt-in */
  locked: boolean;
  /** Stand der .env weicht vom laufenden Prozess ab */
  restartPending: boolean;
}

/** Warum nicht geändert werden darf: Tunnel (Issue #99) oder fehlendes Opt-in */
export type KeysReadOnlyReason = "tunnel" | "switch";

/** Angaben zur einzelnen Anfrage, vom Server gesetzt */
export interface KeyRequest {
  /** Über den Cloudflare Tunnel: nur lesen */
  tunneled?: boolean;
}

export interface KeysApi {
  list(request?: KeyRequest): Promise<ApiResult>;
  put(name: string, body: string, request?: KeyRequest): Promise<ApiResult>;
  remove(name: string, request?: KeyRequest): Promise<ApiResult>;
}

export interface KeysApiOptions {
  /**
   * Sperren aufheben, nur für interne Aufrufer (Einrichtungsmodus M8).
   * Nie aus einer Anfrage befüllen; der Server übergibt das nie.
   */
  unlocked?: ReadonlySet<string>;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

function isSwitchOn(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

function isSet(value: string | undefined): boolean {
  return (value ?? "").trim() !== "";
}

export function createKeysApi(port: KeysPort, log: (message: string) => void, options: KeysApiOptions = {}): KeysApi {
  const unlocked = options.unlocked ?? new Set<string>();
  const locked = (name: string) => isLockedKey(name, unlocked);

  function last4(name: string, value: string | undefined): string | null {
    if (!isSet(value) || locked(name)) return null;
    const v = value!.trim();
    return v.length >= MIN_LENGTH_FOR_LAST4 ? v.slice(-4) : null;
  }

  type Read = { file: Record<string, string>; error?: undefined } | { error: ApiResult };

  async function readFile(): Promise<Read> {
    try {
      return { file: await port.read() };
    } catch (e) {
      log(`Schlüssel: .env nicht lesbar (${errorName(e)})`);
      return { error: { status: 500, body: { error: KEYS_TEXT.notReadable } } };
    }
  }

  function editAllowed(file: Record<string, string>): boolean {
    return port.editEnabledAtStart() && isSwitchOn(file[KEY_EDIT_SWITCH]);
  }

  /** Tunnel, Name und Schreibrecht prüfen; ApiResult heißt abgelehnt */
  async function guard(name: string, request: KeyRequest): Promise<ApiResult | null> {
    // Vor allem anderen: von unterwegs nie schreiben, auch nicht versuchsweise
    if (request.tunneled) {
      log("Schlüsseländerung über den Tunnel abgelehnt");
      return { status: 403, body: { error: KEYS_TEXT.homeOnly, editAllowed: false, homeOnly: true } };
    }
    if (!isValidKeyName(name)) return { status: 400, body: { error: KEYS_TEXT.invalidName } };
    // Gesperrt unabhängig vom Opt-in
    if (locked(name)) return { status: 403, body: { error: KEYS_TEXT.locked, locked: true } };
    const read = await readFile();
    if (read.error) return read.error;
    if (!editAllowed(read.file)) return { status: 403, body: { error: KEYS_TEXT.readOnly, editAllowed: false } };
    return null;
  }

  return {
    async list(request = {}) {
      const read = await readFile();
      if (read.error) return read.error;
      const file = read.file;
      const running = port.running();
      const allowed = !request.tunneled && editAllowed(file);
      const readOnlyReason: KeysReadOnlyReason | null = request.tunneled ? "tunnel" : allowed ? null : "switch";
      const info = (name: string, group: string, description: string | null): KeyInfo => ({
        name,
        group,
        description,
        set: isSet(file[name]),
        last4: last4(name, file[name]),
        editable: allowed && !locked(name),
        locked: locked(name),
        restartPending: (file[name] ?? "").trim() !== (running[name] ?? "").trim(),
      });
      const keys = KEY_CATALOG.map(e => info(e.name, e.group, e.description));
      // Weitere Variablen aus der .env, nur mit gültigem Namen
      const others = Object.keys(file)
        .filter(n => !catalogEntry(n) && isValidKeyName(n))
        .sort();
      for (const name of others) keys.push(info(name, OTHER_GROUP, null));
      return { status: 200, body: { editAllowed: allowed, readOnlyReason, keys } };
    },

    async put(name, body, request = {}) {
      const denied = await guard(name, request);
      if (denied) return denied;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { status: 400, body: { error: KEYS_TEXT.invalidRequest } };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as any).value !== "string") {
        return { status: 400, body: { error: KEYS_TEXT.invalidRequest } };
      }
      // Zeilenumbrüche und Steuerzeichen am Rand zählen auch: vor trim() prüfen
      const raw = (parsed as { value: string }).value;
      if (/[\u0000-\u001f\u007f]/.test(raw)) return { status: 400, body: { error: envValueProblem(raw) } };
      // Umgebende Leerzeichen sind fast immer ein Kopierfehler
      const value = raw.trim();
      const problem = envValueProblem(value);
      if (problem) return { status: 400, body: { error: problem } };
      try {
        await port.set(name, value);
      } catch (e) {
        log(`Schlüssel ${name} nicht gespeichert (${errorName(e)})`);
        return { status: 500, body: { error: KEYS_TEXT.notSaved } };
      }
      log(`Schlüssel ${name} gesetzt über die WebUI`);
      return {
        status: 200,
        body: { name, set: true, last4: last4(name, value), restartRequired: true, message: KEYS_TEXT.saved },
      };
    },

    async remove(name, request = {}) {
      const denied = await guard(name, request);
      if (denied) return denied;
      let removed: boolean;
      try {
        removed = await port.remove(name);
      } catch (e) {
        log(`Schlüssel ${name} nicht gelöscht (${errorName(e)})`);
        return { status: 500, body: { error: KEYS_TEXT.notSaved } };
      }
      if (!removed) return { status: 404, body: { error: KEYS_TEXT.notSet } };
      log(`Schlüssel ${name} gelöscht über die WebUI`);
      return { status: 200, body: { name, set: false, last4: null, restartRequired: true, message: KEYS_TEXT.removed } };
    },
  };
}
