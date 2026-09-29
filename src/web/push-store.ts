/**
 * Push-Abos pro Gerät (Issue #225): data/web/push-subscriptions.json, 0600,
 * atomar geschrieben (temporäre Datei, dann umbenennen), Ordner 0700.
 *
 * Der Stand liegt im Speicher; jede Änderung (Anlegen, Umbenennen, Löschen,
 * lastOkAt nach einem Versand) ändert genau einen Eintrag in einer Kopie des
 * aktuellen Stands, schreibt die ganze Liste über eine Kette nacheinander und
 * übernimmt die Kopie erst nach erfolgreichem Schreiben. So gehen
 * gleichzeitige Änderungen (Abo-Update während eines Versands) nicht verloren.
 *
 * lastOkAt heißt: der Push-Dienst hat die letzte Nachricht angenommen, nicht,
 * dass sie auf dem Gerät angekommen ist.
 *
 * Einstellungen pro Gerät (Issue #226): Kategorien Antworten, Rückfragen,
 * Meldungen und „Inhalt zeigen". Sie bleiben über Abo-Erneuerung (neuer
 * Endpunkt) und Neustart erhalten. Einträge ohne vollständige Einstellungen
 * (Abos aus #225) bekommen beim Laden die Standardwerte und werden einmal
 * so geschrieben, damit ein späterer Wechsel des Telegram-Stands sie nicht
 * still ändert.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePushEndpoint, validPushKeys, type PushTarget } from "./push";

export const PUSH_SUBSCRIPTIONS_FILE = "push-subscriptions.json";
export const MAX_PUSH_DEVICES = 20;
export const DEVICE_NAME_MAX_CHARS = 40;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Einstellungen des Geräts (Issue #226) */
export interface PushDeviceSettings {
  /** Fertige Antworten in Gesprächen, die gerade nicht sichtbar offen sind */
  replies: boolean;
  /** Neue Rückfragen aus dem Register */
  choices: boolean;
  /** Meldungen (Pipeline, Jobs, Briefing, Dateien …) */
  notices: boolean;
  /** Antwort- bzw. Meldungstext und Dateinamen in der Benachrichtigung (Sperrbildschirm) */
  preview: boolean;
}

export const PUSH_SETTING_KEYS = ["replies", "choices", "notices", "preview"] as const;

/**
 * Standard für neue Geräte: Antworten und Rückfragen an, Inhalt aus;
 * Meldungen nur ohne Telegram an (sonst käme jede Meldung doppelt)
 */
export function defaultPushSettings(telegram: boolean): PushDeviceSettings {
  return { replies: true, choices: true, notices: !telegram, preview: false };
}

/** Vollständige Einstellungen aus gespeicherten Werten; fehlende oder ungültige Felder aus defaults */
function pickSettings(value: unknown, defaults: PushDeviceSettings): { settings: PushDeviceSettings; complete: boolean } {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const settings = { ...defaults };
  let complete = true;
  for (const key of PUSH_SETTING_KEYS) {
    if (typeof v[key] === "boolean") settings[key] = v[key] as boolean;
    else complete = false;
  }
  return { settings, complete };
}

/** Teiländerung aus dem Browser; null, wenn etwas anderes als bekannte Schalter drinsteht */
export function parseSettingsPatch(value: unknown): Partial<PushDeviceSettings> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Partial<PushDeviceSettings> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(PUSH_SETTING_KEYS as readonly string[]).includes(key) || typeof v !== "boolean") return null;
    out[key as keyof PushDeviceSettings] = v;
  }
  return Object.keys(out).length ? out : null;
}

export interface PushDevice extends PushTarget {
  id: string;
  name: string;
  createdAt: string;
  lastOkAt?: string;
  settings: PushDeviceSettings;
}

/** Was der Browser sieht: nie Endpunkt oder Schlüssel */
export interface ApiPushDevice {
  id: string;
  name: string;
  createdAt: string;
  lastOkAt: string | null;
  settings: PushDeviceSettings;
}

export function toApiDevice(d: PushDevice): ApiPushDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastOkAt: d.lastOkAt ?? null, settings: { ...d.settings } };
}

export function isPushDeviceId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Name aus Eingabe: getrimmt, 1 bis 40 Zeichen, keine Steuerzeichen; sonst null */
export function normalizeDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || [...name].length > DEVICE_NAME_MAX_CHARS || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}

/** Grober Gerätename aus dem User-Agent, etwa „iPhone · Safari" */
export function deviceNameFromUserAgent(ua: string | null | undefined): string {
  const s = ua ?? "";
  const device = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Macintosh|Mac OS X/.test(s)
          ? "Mac"
          : /Windows/.test(s)
            ? "Windows"
            : /Linux|X11/.test(s)
              ? "Linux"
              : "Gerät";
  const browser = /Edg(A|iOS)?\//.test(s)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(s)
      ? "Firefox"
      : /OPR\//.test(s)
        ? "Opera"
        : /Chrome\/|CriOS\//.test(s)
          ? "Chrome"
          : /Safari\//.test(s)
            ? "Safari"
            : "";
  return browser ? `${device} · ${browser}` : device;
}

function pickDevice(v: unknown, defaults: PushDeviceSettings): { device: PushDevice; complete: boolean } | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (!isPushDeviceId(d.id) || !parsePushEndpoint(d.endpoint) || !validPushKeys(d.keys)) return null;
  const name = normalizeDeviceName(d.name) ?? "Gerät";
  if (typeof d.createdAt !== "string") return null;
  const keys = d.keys as PushTarget["keys"];
  const { settings, complete } = pickSettings(d.settings, defaults);
  return {
    device: {
      id: d.id,
      endpoint: d.endpoint as string,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      name,
      createdAt: d.createdAt,
      ...(typeof d.lastOkAt === "string" ? { lastOkAt: d.lastOkAt } : {}),
      settings,
    },
    complete,
  };
}

export type UpsertResult =
  | { status: "ok"; device: PushDevice; created: boolean }
  /** Gerät mit dieser ID (oder altem Endpunkt) gibt es nicht mehr: nicht still neu anlegen */
  | { status: "unknown" }
  | { status: "full" };

export interface UpsertInput extends PushTarget {
  /** Bekanntes Gerät (aus dem Browser): Endpunkt und Schlüssel ersetzen, Rest bleibt */
  id?: string;
  /** Abo-Wechsel im Service Worker: Gerät am alten Endpunkt finden */
  previousEndpoint?: string;
  /** Name für ein neues Gerät */
  name: string;
}

function sortDevices(devices: Map<string, PushDevice>): PushDevice[] {
  return [...devices.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export class PushSubscriptionStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly max: number;
  private devices = new Map<string, PushDevice>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly write: typeof writeFile;
  private readonly defaults: PushDeviceSettings;

  /**
   * writeFile nur für Tests: Attrappe, die Schreibfehler auslöst. telegram:
   * ist Telegram eingerichtet (Standard für Meldungen, siehe defaultPushSettings)
   */
  constructor(options: { file: string; now?: () => number; max?: number; writeFile?: typeof writeFile; telegram?: boolean }) {
    this.file = options.file;
    this.defaults = defaultPushSettings(options.telegram ?? true);
    this.write = options.writeFile ?? writeFile;
    this.now = options.now ?? Date.now;
    this.max = options.max ?? MAX_PUSH_DEVICES;
  }

  static fileIn(dataDir: string): string {
    return join(dataDir, PUSH_SUBSCRIPTIONS_FILE);
  }

  /** Fehlende Datei heißt: keine Abos. Unlesbare Einträge fallen weg. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = [];
    }
    const next = new Map<string, PushDevice>();
    let migrate = false;
    for (const v of Array.isArray(data) ? data : []) {
      const picked = pickDevice(v, this.defaults);
      if (!picked || next.size >= this.max) continue;
      next.set(picked.device.id, picked.device);
      if (!picked.complete) migrate = true;
    }
    this.devices = next;
    // Abos ohne Einstellungen (aus #225): Standardwerte einmal festschreiben; scheitert das, gelten sie im Speicher
    if (migrate) await this.run(() => this.commit(new Map(this.devices))).catch(() => {});
  }

  list(): PushDevice[] {
    return sortDevices(this.devices);
  }

  get(id: string): PushDevice | undefined {
    return this.devices.get(id);
  }

  private byEndpoint(endpoint: string): PushDevice | undefined {
    for (const d of this.devices.values()) if (d.endpoint === endpoint) return d;
    return undefined;
  }

  upsert(input: UpsertInput): Promise<UpsertResult> {
    return this.run(async () => {
      let target: PushDevice | undefined;
      if (input.id !== undefined) {
        target = this.devices.get(input.id);
        if (!target) return { status: "unknown" as const };
      } else if (input.previousEndpoint !== undefined) {
        target = this.byEndpoint(input.previousEndpoint) ?? this.byEndpoint(input.endpoint);
        if (!target) return { status: "unknown" as const };
      } else {
        target = this.byEndpoint(input.endpoint);
      }
      const next = new Map(this.devices);
      // Derselbe Endpunkt gehört nur zu einem Gerät
      const other = this.byEndpoint(input.endpoint);
      if (target && other && other.id !== target.id) next.delete(other.id);
      if (target) {
        const device = { ...target, endpoint: input.endpoint, keys: { ...input.keys } };
        next.set(device.id, device);
        await this.commit(next);
        return { status: "ok" as const, device, created: false };
      }
      if (this.devices.size >= this.max) return { status: "full" as const };
      const device: PushDevice = {
        id: crypto.randomUUID(),
        endpoint: input.endpoint,
        keys: { ...input.keys },
        name: input.name,
        createdAt: new Date(this.now()).toISOString(),
        settings: { ...this.defaults },
      };
      next.set(device.id, device);
      await this.commit(next);
      return { status: "ok" as const, device, created: true };
    });
  }

  rename(id: string, name: string): Promise<PushDevice | null> {
    return this.run(async () => {
      const d = this.devices.get(id);
      if (!d) return null;
      const device = { ...d, name };
      await this.commit(new Map(this.devices).set(id, device));
      return device;
    });
  }

  /** Einstellungen ändern (nur die übergebenen Schalter); null bei unbekanntem Gerät */
  updateSettings(id: string, patch: Partial<PushDeviceSettings>): Promise<PushDevice | null> {
    return this.run(async () => {
      const d = this.devices.get(id);
      if (!d) return null;
      const device = { ...d, settings: { ...d.settings, ...patch } };
      await this.commit(new Map(this.devices).set(id, device));
      return device;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.run(async () => {
      if (!this.devices.has(id)) return false;
      const next = new Map(this.devices);
      next.delete(id);
      await this.commit(next);
      return true;
    });
  }

  /**
   * Nach einem Versand an genau diesen Endpunkt: hat das Gerät inzwischen
   * einen neuen, bleibt es unberührt (der alte war es, der abgelaufen ist).
   */
  markOk(id: string, endpoint: string): Promise<void> {
    return this.run(async () => {
      const d = this.devices.get(id);
      if (!d || d.endpoint !== endpoint) return;
      await this.commit(new Map(this.devices).set(id, { ...d, lastOkAt: new Date(this.now()).toISOString() }));
    });
  }

  removeIfEndpoint(id: string, endpoint: string): Promise<boolean> {
    return this.run(async () => {
      const d = this.devices.get(id);
      if (!d || d.endpoint !== endpoint) return false;
      const next = new Map(this.devices);
      next.delete(id);
      await this.commit(next);
      return true;
    });
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(fn);
    this.chain = next;
    return next;
  }

  /** Schreibt den neuen Stand; erst danach gilt er auch im Speicher. Scheitert das Schreiben, bleibt alles beim Alten. */
  private async commit(next: Map<string, PushDevice>): Promise<void> {
    await this.persist(next);
    this.devices = next;
  }

  private async persist(devices: Map<string, PushDevice>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      await this.write(tmp, JSON.stringify(sortDevices(devices), null, 2), { mode: 0o600, flag: "wx" });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
}
