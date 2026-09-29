/**
 * Routen für Web Push (Issue #225), vom Server nach Anmeldung, Origin-Prüfung
 * (schreibend) und Access-Nachweis (Tunnel) aufgerufen:
 *
 * - GET /api/push: öffentlicher Schlüssel, bekannte Geräte (ohne Endpunkte)
 * - POST /api/push/subscriptions: Abo anlegen oder aktualisieren. Mit id
 *   (Browser kennt sein Gerät) oder previousEndpoint (Abo-Wechsel im Service
 *   Worker) nur ein vorhandenes Gerät; gibt es das nicht mehr, 404 statt
 *   still neu anlegen. Ohne beides: gleicher Endpunkt ersetzt, sonst neu.
 * - PATCH /api/push/subscriptions/<id>: umbenennen ({ name }) und/oder
 *   Einstellungen ändern ({ settings: { replies, choices, notices, preview } },
 *   nur die genannten Schalter; Issue #226)
 * - DELETE /api/push/subscriptions/<id>: entfernen
 * - POST /api/push/test: Test an genau dieses Gerät. Der Browser schickt sein
 *   aktuelles Abo (endpoint) mit; meldet der Dienst 404/410, sagt die Antwort,
 *   ob das Gerät wirklich entfernt wurde (removed) und ob es genau dieses Abo
 *   war (subscriptionGone). Wurde das Abo während des Versands erneuert, bleibt
 *   das Gerät (409, removed: false).
 *
 * Nie im Ergebnis oder Log: privater Schlüssel, Endpunkt (Pfad), Abo-Schlüssel.
 */

import {
  endpointHost,
  parsePushEndpoint,
  sendPush,
  validPushKeys,
  validPushKeysStrict,
  type PushMessage,
  type SendOptions,
  type SendResult,
  type VapidKeys,
} from "./push";
import {
  deviceNameFromUserAgent,
  isPushDeviceId,
  MAX_PUSH_DEVICES,
  normalizeDeviceName,
  parseSettingsPatch,
  PushSubscriptionStore,
  toApiDevice,
  type PushDevice,
} from "./push-store";

/** Was der Bot beim Start vorbereitet (./bot-push) */
export interface PushConfig {
  keys: VapidKeys;
  subject: string;
  /**
   * Telegram eingerichtet (Issue #226): dann sind Meldungen auf neuen Geräten
   * standardmäßig aus. Fehlt die Angabe, gilt „eingerichtet" (lieber keine
   * doppelten Meldungen)
   */
  telegram?: boolean;
}

export interface PushDeps extends PushConfig {
  /** Standard: <dataDir>/push-subscriptions.json */
  file?: string;
  /** Nur für Tests: Attrappe statt echtem Versand */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const PUSH_TEXT = {
  notConfigured: "Push ist auf diesem Server nicht eingerichtet. Beim nächsten Start mit eingeschalteter WebUI legt tybo die Schlüssel selbst an.",
  badRequest: "Ungültige Anfrage",
  unknownService: "Diese Push-Adresse gehört zu keinem bekannten Push-Dienst",
  badKeys: "Schlüssel des Abos ungültig",
  unknownDevice: "Dieses Gerät ist nicht mehr angemeldet. Zum Einschalten neu tippen.",
  full: `Höchstens ${MAX_PUSH_DEVICES} Geräte. Bitte erst ein altes Gerät entfernen.`,
  badName: "Name muss 1 bis 40 Zeichen haben",
  badSettings: "Ungültige Einstellungen",
  gone: "Der Push-Dienst kennt dieses Gerät nicht mehr. Bitte Benachrichtigungen neu einschalten.",
  renewed: "Das Abo dieses Geräts wurde gerade erneuert. Bitte den Test noch einmal senden.",
  retry: "Der Push-Dienst ist gerade nicht erreichbar oder ausgelastet. Bitte später noch einmal.",
  failed: "Der Push-Dienst hat die Nachricht abgelehnt.",
  testTitle: "Test",
  /** Kategorie des Test-Pushs im Versandlog */
  testLabel: "Test",
  testBody: "Benachrichtigungen auf diesem Gerät funktionieren.",
} as const;

export const PUSH_TEST_URL = "/#/einstellungen/benachrichtigungen";

interface ApiResult {
  status: number;
  body: unknown;
}

export interface PushApi {
  get(): ApiResult;
  subscribe(body: string, userAgent: string | null): Promise<ApiResult>;
  /** Umbenennen und/oder Einstellungen ändern (PATCH) */
  rename(id: string, body: string): Promise<ApiResult>;
  remove(id: string): Promise<ApiResult>;
  test(body: string): Promise<ApiResult>;
  /** Versand an ein Gerät mit Aufräumen (404/410 löscht) und Log ohne Endpunkt-Pfad; für #226 */
  send(device: PushDevice, message: PushMessage, options?: SendPushOptions): Promise<DeliveryResult>;
}

/** label: Kategorie im Log (Antwort, Rückfrage, Meldung; ohne Angabe Test) */
export type SendPushOptions = Pick<SendOptions, "ttl" | "urgency" | "topic"> & { label?: string };

/**
 * Ergebnis des Versands; bei gone sagt removed, ob das Gerät entfernt wurde.
 * false heißt: es hat inzwischen einen neuen Endpunkt und bleibt.
 */
export type DeliveryResult = Exclude<SendResult, { status: "gone" }> | { status: "gone"; code: number; removed: boolean };

/**
 * Ergebnis für das Versandlog, eine Zeile je Push mit Kategorie, Gerät und
 * Ergebnis (Issue #226). Nie Inhalt, Endpunkt oder Host des Dienstes.
 */
export function deliveryText(result: DeliveryResult): string {
  switch (result.status) {
    case "ok":
      return "ok";
    case "gone":
      return result.removed ? `abgelaufen (${result.code}), Gerät entfernt` : `abgelaufen (${result.code}), Gerät hat ein neues Abo und bleibt`;
    case "retry":
      return `nicht angenommen (${result.code}), Abo bleibt`;
    case "error":
      return `fehlgeschlagen (${result.reason})`;
    case "rejected":
      return `abgelehnt (${result.reason})`;
  }
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function createPushApi(store: PushSubscriptionStore, deps: PushDeps, log: (message: string) => void): PushApi {
  async function send(device: PushDevice, message: PushMessage, options: SendPushOptions = {}): Promise<DeliveryResult> {
    const { label = PUSH_TEXT.testLabel, ...sendOptions } = options;
    const endpoint = device.endpoint;
    const result = await sendPush(device, message, {
      keys: deps.keys,
      subject: deps.subject,
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
      ...sendOptions,
    });
    let delivery: DeliveryResult = result as DeliveryResult;
    if (result.status === "ok") {
      await store.markOk(device.id, endpoint);
    } else if (result.status === "gone") {
      // Nur das Abo, an das gesendet wurde; ein inzwischen erneuertes bleibt
      delivery = { ...result, removed: await store.removeIfEndpoint(device.id, endpoint) };
    }
    log(`Push (${label}) an „${device.name}": ${deliveryText(delivery)}`);
    return delivery;
  }

  return {
    get() {
      return {
        status: 200,
        body: { available: true, publicKey: deps.keys.publicKey, devices: store.list().map(toApiDevice), max: MAX_PUSH_DEVICES },
      };
    },

    async subscribe(body, userAgent) {
      const data = parse(body);
      const sub = data?.subscription;
      if (!data || !sub || typeof sub !== "object") return { status: 400, body: { error: PUSH_TEXT.badRequest } };
      const { endpoint, keys } = sub as Record<string, unknown>;
      if (!parsePushEndpoint(endpoint)) return { status: 400, body: { error: PUSH_TEXT.unknownService } };
      if (!(await validPushKeysStrict(keys)) || !validPushKeys(keys)) return { status: 400, body: { error: PUSH_TEXT.badKeys } };
      if (data.id !== undefined && !isPushDeviceId(data.id)) return { status: 400, body: { error: PUSH_TEXT.badRequest } };
      if (data.previousEndpoint !== undefined && (typeof data.previousEndpoint !== "string" || data.previousEndpoint.length > 2048)) {
        return { status: 400, body: { error: PUSH_TEXT.badRequest } };
      }
      const result = await store.upsert({
        endpoint: endpoint as string,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        ...(data.id !== undefined ? { id: data.id as string } : {}),
        ...(data.previousEndpoint !== undefined ? { previousEndpoint: data.previousEndpoint as string } : {}),
        name: deviceNameFromUserAgent(userAgent),
      });
      if (result.status === "unknown") return { status: 404, body: { error: PUSH_TEXT.unknownDevice, removed: true } };
      if (result.status === "full") return { status: 409, body: { error: PUSH_TEXT.full } };
      if (result.created) log(`Push-Gerät angemeldet: „${result.device.name}" (${endpointHost(result.device.endpoint)})`);
      return { status: result.created ? 201 : 200, body: { device: toApiDevice(result.device) } };
    },

    async rename(id, body) {
      if (!isPushDeviceId(id)) return { status: 404, body: { error: PUSH_TEXT.unknownDevice } };
      const data = parse(body);
      if (!data || (data.name === undefined && data.settings === undefined)) return { status: 400, body: { error: PUSH_TEXT.badRequest } };
      const name = data.name === undefined ? null : normalizeDeviceName(data.name);
      if (data.name !== undefined && !name) return { status: 400, body: { error: PUSH_TEXT.badName } };
      const patch = data.settings === undefined ? null : parseSettingsPatch(data.settings);
      if (data.settings !== undefined && !patch) return { status: 400, body: { error: PUSH_TEXT.badSettings } };
      let device = name ? await store.rename(id, name) : store.get(id) ?? null;
      if (device && patch) device = await store.updateSettings(id, patch);
      if (!device) return { status: 404, body: { error: PUSH_TEXT.unknownDevice } };
      return { status: 200, body: { device: toApiDevice(device) } };
    },

    async remove(id) {
      if (!isPushDeviceId(id)) return { status: 404, body: { error: PUSH_TEXT.unknownDevice } };
      const device = store.get(id);
      if (!(await store.remove(id))) return { status: 404, body: { error: PUSH_TEXT.unknownDevice } };
      log(`Push-Gerät entfernt: „${device?.name ?? "?"}"`);
      return { status: 200, body: { removed: true } };
    },

    async test(body) {
      const data = parse(body);
      const id = data?.id;
      if (!isPushDeviceId(id)) return { status: 400, body: { error: PUSH_TEXT.badRequest } };
      const browserEndpoint = data?.endpoint;
      if (browserEndpoint !== undefined && (typeof browserEndpoint !== "string" || browserEndpoint.length > 2048)) {
        return { status: 400, body: { error: PUSH_TEXT.badRequest } };
      }
      const device = store.get(id);
      if (!device) return { status: 404, body: { error: PUSH_TEXT.unknownDevice, removed: true } };
      const result = await send(
        device,
        { title: PUSH_TEXT.testTitle, body: PUSH_TEXT.testBody, tag: "test", url: PUSH_TEST_URL },
        { ttl: 60, urgency: "high", topic: "test" }
      );
      if (result.status === "ok") return { status: 200, body: { ok: true } };
      if (result.status === "gone") {
        if (!result.removed) return { status: 409, body: { error: PUSH_TEXT.renewed, removed: false } };
        // Nur wenn der Browser genau dieses Abo hat, soll er es auch bei sich abmelden
        return { status: 410, body: { error: PUSH_TEXT.gone, removed: true, subscriptionGone: browserEndpoint === device.endpoint } };
      }
      if (result.status === "retry") return { status: 502, body: { error: PUSH_TEXT.retry } };
      return { status: 502, body: { error: PUSH_TEXT.failed } };
    },

    send,
  };
}
