/**
 * Health-Server des Bot-Prozesses (Issue #343, Entscheidung 0001): eigener
 * Port im selben Prozess, nur lokal (HEALTH_HOST, Standard 127.0.0.1;
 * HEALTH_PORT, Standard 3000).
 *
 * Wege:
 * - GET / und /health: Lebenszeichen als JSON mit Laufzeit, PID und der
 *   zuletzt gemeldeten Session (frisch bei jeder Anfrage gelesen).
 * - POST /process: Auftrag von außen, etwa der Denkauftrag der Sprach-Brücke
 *   (src/voice-bridge.ts) oder eine weitergereichte Nachricht im
 *   Hybrid-Modus. Prüfung und Annahme macht createProcessHandler
 *   (src/lib/process-handler.ts): Bearer GATEWAY_SECRET, Chat-Freigabe,
 *   Form, 64 KiB, höchstens 16 offene Aufträge, sofort 202. Die Arbeit selbst
 *   (processInBackground) gibt der Bot hinein.
 * - POST /relay: nur im Profil peer mit Hybrid (Issue #353), weitergereichte
 *   Telegram-Updates vom Server (src/lib/hybrid/relay-endpoint.ts). Nur dann
 *   nimmt der Server Anfragen bis 1 MiB an; /process prüft seine 64 KiB selbst.
 * - alles andere: 404.
 *
 * Dazu die beiden Bausteine für Fotos im Auftrag: Laden aus Telegram nach
 * uploads/ und das Nachtragen der Bild-Beschreibung aus der Antwort.
 *
 * Beim Import startet nichts; startHealthServer gibt stop() zurück.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { GrammyError } from "grammy";
import { downloadTelegramFile, type TelegramFileApi } from "../channels/telegram/media-inbox";
import { parseAssetDescTag, stripAssetDescTag } from "../lib/assets/tags";
import { uploadName } from "../lib/media-turn";
import type { ProcessRequest } from "../lib/process-background";
import { createProcessHandler } from "../lib/process-handler";
import type { LastSession } from "./last-session";

/** Dienstname in der Health-Antwort; Prüfskripte erkennen den Bot daran */
export const HEALTH_SERVICE = "tybo-telegram-bot";

/** Größte Anfrage, die Bun überhaupt annimmt (der Process-Handler prüft selbst noch einmal) */
const BODY_LIMIT = 64 * 1024;
/** Mit /relay: so groß wie am Webhook-Listener */
const RELAY_BODY_LIMIT = 1024 * 1024;

export function healthAddress(env: Record<string, string | undefined>): { hostname: string; port: number } {
  return {
    hostname: env.HEALTH_HOST || "127.0.0.1",
    port: parseInt(env.HEALTH_PORT || "3000", 10),
  };
}

export interface HealthServerOptions {
  /** 0: freier Port (Tests) */
  port: number;
  hostname?: string;
  session(): LastSession;
  /** Bearer-Geheimnis für /process; leer: /process antwortet 503 */
  secret(): string;
  allowChat(chatId: string): boolean;
  /** läuft nach der 202-Antwort im Hintergrund */
  process(request: ProcessRequest): Promise<void>;
  /** offene /process-Aufträge, Standard 16 */
  capacity?: number;
  /** POST /relay (Hybrid, Profil peer); ohne Angabe gibt es den Weg nicht */
  relay?: ((request: Request) => Promise<Response>) | null;
  uptime?: () => number;
  pid?: number;
  now?: () => Date;
}

export interface HealthServer {
  readonly port: number;
  readonly hostname: string;
  stop(): Promise<void>;
}

export function startHealthServer(options: HealthServerOptions): HealthServer {
  const uptime = options.uptime ?? (() => process.uptime());
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  // Ein Handler für den ganzen Server: nur so zählt die Grenze offener Aufträge
  const acceptJob = createProcessHandler({
    secret: options.secret,
    allowChat: options.allowChat,
    process: options.process,
    capacity: options.capacity,
  });

  const status = () => {
    const session = options.session();
    return Response.json({
      status: "ok",
      service: HEALTH_SERVICE,
      uptime: uptime(),
      pid,
      sessionId: session.sessionId,
      sessionEngine: session.engine,
      timestamp: now().toISOString(),
    });
  };

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    maxRequestBodySize: options.relay ? RELAY_BODY_LIMIT : BODY_LIMIT,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/" || pathname === "/health") return status();
      if (pathname === "/process" && req.method === "POST") return acceptJob(req);
      if (pathname === "/relay" && options.relay) return options.relay(req);
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    port: server.port ?? options.port,
    hostname: server.hostname ?? options.hostname ?? "127.0.0.1",
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Fotos in /process-Aufträgen
// ---------------------------------------------------------------------------

export interface TelegramPhotoDeps {
  /** null: Telegram ist nicht eingerichtet */
  api(): TelegramFileApi | null;
  token: string;
  /** Ablage, üblicherweise <Projekt>/uploads */
  dir: string;
  now?: () => number;
  uuid?: () => string;
  fetch?: (url: string) => Promise<Response>;
}

const PHOTO_EXT = /\.([a-zA-Z0-9]{1,10})$/;

/**
 * getFile, bei dem eine Ablehnung durch Telegram (GrammyError, etwa eine
 * ungültige oder abgelaufene file_id) als „kein Dateipfad" zählt. Fehler auf
 * dem Weg dorthin (HttpError, Netz) bleiben Fehler.
 */
function rejectionWithoutPath(api: TelegramFileApi): TelegramFileApi {
  return {
    getFile: fileId =>
      api.getFile(fileId).catch((err: unknown) => {
        if (err instanceof GrammyError) return {};
        throw err;
      }),
  };
}

/**
 * Lädt ein Foto per file_id (höchstens 20 MB, Fehlermeldungen ohne Token) und
 * legt es als photo_<zeit>_<uuid>.<endung> ab. null, wenn es nichts zu laden
 * gibt (kein Telegram, Telegram lehnt getFile ab, kein Dateipfad, zu groß);
 * dann bekommt der Nutzer die Foto-Meldung. Transportfehler werfen weiter.
 */
export function loadTelegramPhoto(deps: TelegramPhotoDeps): (photoFileId: string) => Promise<string | null> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  return async photoFileId => {
    const api = deps.api();
    if (!api) return null;
    const loaded = await downloadTelegramFile(rejectionWithoutPath(api), photoFileId, { token: deps.token, fetch: deps.fetch });
    if (!loaded.ok) return null;
    const ext = PHOTO_EXT.exec(loaded.filePath)?.[1] ?? "jpg";
    await mkdir(deps.dir, { recursive: true });
    const target = join(deps.dir, uploadName("photo", now(), uuid(), `.${ext}`));
    await writeFile(target, loaded.bytes);
    return target;
  };
}

export interface AssetReplyDeps {
  describe(assetId: string, text: string, keywords?: string[]): Promise<void>;
}

const SENTENCE = /[^.!?]+[.!?]+/g;

/**
 * Trägt die Beschreibung eines hochgeladenen Bildes nach: aus dem
 * [ASSET_DESC:]-Tag, sonst aus den ersten zwei Sätzen der Antwort. Speichern
 * läuft nebenher, ein Fehler dabei bleibt still. Zurück kommt die Antwort ohne
 * Tag.
 */
export function describeAssetFromReply(deps: AssetReplyDeps): (assetId: string | null, response: string) => string {
  const quietly = (work: Promise<void>) => void work.catch(() => {});
  return (assetId, response) => {
    if (assetId) {
      const tagged = parseAssetDescTag(response);
      if (tagged) {
        quietly(deps.describe(assetId, tagged.description, tagged.tags));
      } else {
        const firstTwo = (response.match(SENTENCE) ?? []).slice(0, 2).map(sentence => sentence.trim());
        if (firstTwo.length > 0) quietly(deps.describe(assetId, firstTwo.join(" ")));
      }
    }
    return stripAssetDescTag(response);
  };
}
