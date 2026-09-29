/**
 * Web-Server der WebUI (Issue #2): Login, Session-Cookie, statische Dateien
 * und die Schutzregeln aus docs/webui/decisions/0002-sicherheit.md.
 * Chat-API mit Gesprächsspeicher und Live-Ereignissen seit Issue #4.
 * Telegram-Gespräche (Direktchat, Topics) lesen seit Issue #17, schreiben
 * (gespiegelt nach Telegram) seit Issue #19, neue Nachrichten aus Telegram
 * live im offenen Gespräch und in der Seitenleiste seit Issue #20.
 * Agentenliste, Umbenennen und Löschen von Web-Gesprächen seit Issue #21.
 * Telegram-Topics anlegen, umbenennen, schließen, öffnen und löschen seit
 * Issue #29 (Entscheidung 0005); neue reine Web-Gespräche entstehen nicht mehr.
 * Einstellungen, Agenten-Anweisungen, Topic-Agent und Modell-Listen seit Issue #36.
 * Status und Neustart-Anforderung seit Issue #37.
 * Agenten-Katalog (Prompt, Anlegen, Löschen, Wiederherstellen, Board) seit Issue #50.
 * Terminal-Zugang mit lokalem Schlüssel (nur von Loopback) seit Issue #59.
 * Slash-Befehle aus Browser und Terminal auf dem Server seit Issue #74.
 * Schlüssel in .env (nur Namen, gesetzt, letzte 4 Zeichen; Ändern mit Opt-in) seit Issue #62.
 * Anhänge hochladen, mit einer Nachricht schicken und herunterladen seit Issue #72.
 * Cloudflare-Access-Nachweis für getunnelte Anfragen seit Issue #99 (./access).
 * Oberflächen-Version in index.html und unter /api/version seit Issue #111 (./ui-version).
 * Rückfrage-Knöpfe aus dem Register seit Issue #115 (./choices).
 * Installierbare Web-App (Manifest, Symbole, Service Worker, Offline-Seite)
 * seit Issue #224 (./manifest, ./service-worker).
 * Web Push (Schlüssel, Abos pro Gerät, Test) seit Issue #225 (./push-api).
 * Anwesenheit offener Seiten (POST /api/presence) seit Issue #226 (./presence),
 * Push von selbst für Antworten, Rückfragen und Meldungen (./push-triggers).
 * Importiert nichts aus src/bot.ts; die Einbindung dort folgt in #6.
 */

import { BRAND_SCRIPT_PATH, brandHtmlResponse, brandScriptResponse } from "./brand-asset";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { remoteKind, type WebConfig } from "./config";
import {
  ChatHub,
  toApiMessage,
  validateMessageText,
  type ApiMessage,
  type ChatShutdownOptions,
  type HubConversation,
  type MessageSource,
  type WebChat,
} from "./chat";
import { AGENT_NAME_PATTERN, agentList, DEFAULT_AGENT, FALLBACK_AGENT_NAMES, type AgentInfo } from "./agents";
import { AGENT_ADMIN_PATH, agentAdminMethods, AGENTS_TEXT, createAgentsApi, type AgentCatalogPort } from "./agent-catalog";
import { ConversationStore, DEFAULT_DATA_DIR, isChoiceId, isConversationId, normalizeCustomTitle, webSessionKey } from "./store";
import {
  createTelegramMessageLog,
  parseBeforeCursor,
  parseTelegramConversationId,
  type TelegramConversation,
  type TelegramConversationList,
  type TelegramLiveFeed,
  type TelegramSource,
} from "./telegram";
import { normalizeTopicTitle, TEXT as TOPIC_TEXT, TOPIC_TITLE_MAX_CHARS, type TopicManager } from "./topics";
import { createSettingsApi, SETTINGS_TEXT, type SettingsPort } from "./settings";
import { createModelCatalog, type ModelCatalog, type OpenCodeModelsPort } from "./models";
import { createInstructionsApi, INSTRUCTIONS_PATH, INSTRUCTIONS_TEXT, type InstructionsPort } from "./instructions";
import { createStatusApi, STATUS_TEXT, type StatusPort } from "./status";
import { conversationEngines, createEnginesApi, ENGINE_TEXT, type EngineConversation, type EnginePort } from "./engines";
import { createKeysApi, KEYS_TEXT, type KeysPort } from "./keys";
import { FILES_PATH, serveOutboxFile, type FilesDeps } from "./files";
import { FILE_NAME_HEADER, MAX_ATTACHMENT_BYTES, parseAttachmentName, toApiAttachment, type ApiAttachment } from "./attachments";
import { UPLOAD_TEXT, UploadStore, validateIds } from "./uploads";
import { NOTICE_SOURCE_PATTERN, OUTBOX_FILE_ID_PATTERN, type NoticeFile } from "./notice";
import { startWebNoticeImport, type WebNotice, type WebNoticeImportDeps } from "./web-notices";
import { createCliToken, parseBearer, type CliToken } from "./cli-token";
import { ACCESS_JWT_HEADER, ACCESS_REASON_TEXT, createAccessVerifier, type AccessResult, type FetchCerts } from "./access";
import { SESSION_RESET_TEXT, sessionResetNote, type ConversationSessionReset } from "./session-reset";
import { COMMANDS_TEXT, type CommandMatchInfo, type CommandPort } from "./commands";
import { GOAL_CARD_TEXT, isGoalCardAction, type GoalPort } from "./goals";
import { CHOICE_TEXT, choiceViewFor, type ChoiceChange, type ChoicePort } from "./choices";
import { computeUiVersion, UI_VERSION_PATH } from "./ui-version";
import { MANIFEST_PATH, manifestResponse, SHARE_TARGET_PATH } from "./manifest";
import { SERVICE_WORKER_PATH, serviceWorkerResponse } from "./service-worker";
import { createPushApi, PUSH_TEXT, type PushDeps } from "./push-api";
import { PushSubscriptionStore } from "./push-store";
import { parsePresenceReport, PresenceTracker } from "./presence";
import { createPushNotifier, type PushNotifier } from "./push-triggers";
import {
  LoginLimiter,
  hashToken,
  SESSION_TTL_MS,
  SessionStore,
  isAllowedHost,
  isPublicHost,
  isPublicOrigin,
  isSameOrigin,
  isRemoteRequest,
  requestOrigin,
  passwordMatches,
} from "./auth";

export const COOKIE_NAME = "tybo_web";
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * Nur für neue Chat-Nachrichten: 20.000 Zeichen können als JSON bis zu
 * 12 Bytes pro Zeichen brauchen (\uXXXX\uXXXX), 64 KiB reichen dafür nicht.
 */
export const MAX_MESSAGE_BODY_BYTES = 256 * 1024;
export { DEFAULT_AGENT };
const CONVERSATION_PATH = /^\/api\/conversations\/([^/]+)(?:\/(messages|events|stop|close|reopen|reset|goal))?$/;
/**
 * Rückfragen (Issue #115): POST /api/conversations/<id>/choices/<choiceId>
 * entscheidet, GET /api/conversations/<id>/choices?ids=a,b liefert den Stand
 */
const CHOICE_PATH = /^\/api\/conversations\/([^/]+)\/choices(?:\/([^/]+))?$/;
/** Höchstzahl Fragen je Stand-Abfrage */
const MAX_CHOICE_SNAPSHOT = 200;
/** Anhänge (Issue #72): POST ohne ID lädt hoch, GET mit ID lädt herunter */
const ATTACHMENT_PATH = /^\/api\/conversations\/([^/]+)\/attachments(?:\/([^/]+))?$/;
/** Sammelstrom: letzte Aktivität aller Telegram-Gespräche für die Seitenleiste (Issue #20) */
export const TELEGRAM_ACTIVITY_PATH = "/api/telegram/events";
/** Rechte des Bots in der Forum-Gruppe (Issue #29) */
export const TELEGRAM_RIGHTS_PATH = "/api/telegram/rights";
/** Anwesenheit offener Seiten (Issue #226) */
export const PRESENCE_PATH = "/api/presence";
/** Schlüssel des Sammelstroms im Telegram-Hub; kollidiert nicht mit dm und topic-<n> */
const ACTIVITY_STREAM = "telegram-activity";
export const DEFAULT_PUBLIC_DIR = join(import.meta.dir, "public");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    // Aufnahmen vor dem Senden abspielen (Issue #109): nur Objekt-URLs der eigenen Seite
    "media-src 'self' blob:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
    // Installierbare Web-App (Issue #224): ausdrücklich statt über default-src
    "worker-src 'self'; manifest-src 'self'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Ohne Session erreichbar, dazu /brand.js und /manifest.webmanifest. Host-,
 * Origin- und Access-Prüfung (Tunnel) gelten trotzdem. Nichts davon verrät
 * etwas über den Nutzer.
 */
export const PUBLIC_ASSETS: Record<string, string> = {
  "/login": "login.html",
  "/login.js": "login.js",
  "/theme.js": "theme.js",
  "/style.css": "style.css",
  "/favicon.svg": "favicon.svg",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  // Symbole der installierbaren Web-App (Issue #224), aus scripts/web-icons.ts
  "/icon-192.png": "icon-192.png",
  "/icon-512.png": "icon-512.png",
  "/icon-maskable-512.png": "icon-maskable-512.png",
  // Service Worker und die Seite „nicht erreichbar" samt Knopf-Skript
  "/sw.js": "sw.js",
  "/offline.html": "offline.html",
  "/offline.js": "offline.js",
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Antwort auf getunnelte Anfragen ohne gültigen Access-Nachweis (Issue #99) */
export const ACCESS_DENIED_TEXT =
  "Zugang von unterwegs nur mit gültiger Cloudflare-Access-Anmeldung. Bitte die Seite neu laden und erneut anmelden.";
/** Gleiche Access-Meldungen im Log höchstens einmal pro Minute und Besucher */
const ACCESS_LOG_INTERVAL_MS = 60 * 1000;
/** Web Push (Issue #225): ein Gerät umbenennen oder entfernen */
const PUSH_DEVICE_PATH = /^\/api\/push\/subscriptions\/([^/]+)$/;
/** /api/keys/<name>; die Namensprüfung selbst macht ./keys */
const KEY_PATH = /^\/api\/keys\/([^/]*)$/;

/**
 * Wer die Anfrage stellt: Browser mit Session-Cookie oder Terminal mit dem
 * lokalen Schlüssel (Issue #59). Live-Verbindungen hängen an `session` und
 * enden, sobald isAuthorized() false ergibt (Abmelden, Ablauf, Stopp).
 */
interface RequestAuth {
  session: string;
  isAuthorized(): boolean;
  source: MessageSource;
  /**
   * Von unterwegs (Issue #99): über den Tunnel, über Tailscale oder sonst
   * weitergeleitet (isRemoteRequest, Issue #231); etwa Schlüssel nur lesen
   */
  tunneled: boolean;
}

export interface WebServerDeps {
  /**
   * Dateien aus Meldungen (Issue #47): Nachweis über den festgehaltenen
   * Eintrag und die Ablage; in bot.ts createBotFiles, in web:dev eine
   * Demo-Ablage. Ohne sie antwortet GET /api/files/<id> mit 404.
   */
  files?: FilesDeps;
  /** Standard: data/web-sessions.json im Projekt */
  sessionFile?: string;
  /**
   * Schlüsseldatei für den Terminal-Zugang (Issue #59). Nur wenn gesetzt,
   * legt der Server nach erfolgreichem Start einen neuen Schlüssel dort ab
   * und löscht ihn beim Stopp. startWebUi setzt data/cli-token, web:dev eine
   * eigene Datei, Tests einen temporären Ordner.
   */
  cliTokenFile?: string;
  /** Standard: src/web/public */
  publicDir?: string;
  /** Gesprächsspeicher, Standard: data/web im Projekt */
  dataDir?: string;
  /**
   * Fertig geladener Gesprächsspeicher statt eines neuen aus dataDir. Seit
   * Issue #29 entstehen über die API keine Web-Gespräche mehr; Tests und
   * Browser-Durchlauf legen ältere Web-Gespräche damit direkt an.
   */
  conversationStore?: ConversationStore;
  /** Agenten-Turn; ohne ihn antwortet POST .../messages mit 503 */
  chat?: WebChat;
  /** Telegram-Direktchat und -Topics lesen; ohne sie gibt es keine */
  telegram?: TelegramSource;
  /** Turn für Telegram-Gespräche (Issue #19); ohne ihn antwortet POST dort mit 503 */
  telegramChat?: WebChat;
  /** Neue Nachrichten aus Telegram live an offene Browser (Issue #20); ohne sie nur per Neuladen */
  telegramLive?: TelegramLiveFeed;
  /**
   * Agenten, die ein neues Web-Gespräch bekommen kann (Issue #21); in bot.ts
   * aus dem Agenten-Katalog, als Funktion bei jeder Anfrage neu gelesen
   * (Issue #49: angelegte und gelöschte Agenten ohne Neustart). Standard:
   * FALLBACK_AGENT_NAMES aus ./agents
   */
  agents?: AgentInfo[] | (() => AgentInfo[]);
  /**
   * Agenten-Katalog (Issue #50): Routen zum Verwalten der Agenten. In bot.ts
   * botAgentCatalog aus ./bot-agents, in web:dev und Demo eine Attrappe
   * im Speicher. Ohne agents kommt auch die Auswahl für neue Gespräche und
   * die Topic-Zuordnung daraus. Ohne ihn antworten die neuen Routen mit 503.
   */
  agentCatalog?: AgentCatalogPort;
  /**
   * Setzt die Claude-Session eines gelöschten Web-Gesprächs zurück, Schlüssel
   * web:<id> (Issue #21); in bot.ts resetSession aus src/lib/session-manager.
   * web:dev, Demo und Tests setzen keine echte Session zurück.
   */
  resetSession?: (sessionKey: string) => Promise<unknown>;
  /**
   * Session eines Gesprächs frisch starten wie /new in Telegram (Issue #61),
   * POST /api/conversations/<id>/reset. In bot.ts createBotSessionReset,
   * in web:dev und Tests eine Attrappe. Ohne ihn antwortet die Route mit 503.
   */
  resetConversation?: ConversationSessionReset;
  /**
   * Telegram-Topics verwalten (Issue #29): anlegen, umbenennen, schließen,
   * öffnen, löschen, Rechte. In bot.ts createBotTopics, in Demo und Tests
   * mit Attrappen. Ohne sie antworten Anlegen und Verwaltung mit 503.
   */
  topics?: TopicManager;
  /**
   * Einstellungen lesen und ändern (Issue #36); in bot.ts botSettings aus
   * ./bot-settings. Ohne sie antwortet /api/settings mit 503.
   */
  settings?: SettingsPort;
  /**
   * Agenten-Anweisungen wie /agent (Issue #36); in bot.ts botInstructions
   * aus ./bot-settings. Ohne sie antworten die Routen mit 503.
   */
  instructions?: InstructionsPort;
  /**
   * Modell-Listen für GET /api/models (Issue #36). Standard: öffentliche
   * OpenRouter-Liste und lokales Ollama; Tests reichen eine Attrappe herein.
   */
  models?: ModelCatalog;
  /**
   * `opencode models` für die Standard-Modell-Liste (Issue #129); in bot.ts
   * listOpenCodeModels aus src/lib/engines/opencode.ts. Fehlt: die Liste
   * meldet OpenCode als nicht abrufbar, das Feld bleibt frei eingebbar.
   */
  opencodeModels?: OpenCodeModelsPort;
  /**
   * Status und Neustart-Anforderung (Issue #37); in bot.ts createBotStatus
   * aus ./bot-status, in web:dev und Demo createDemoStatus (schreibt nie
   * den echten Marker). Ohne ihn antworten /api/status und /api/restart mit 503.
   */
  status?: StatusPort;
  /**
   * Motor-Wahl (Issue #126): GET /api/engines (Standard, Verfügbarkeit,
   * abweichende Gespräche), POST /api/engines/reset („Auf Standard"), Motor
   * je Gespräch in GET /api/conversations und das SSE-Ereignis engine im
   * Sammelstrom. In bot.ts createBotEngines aus ./bot-engines, in Demo und
   * Tests eine Attrappe. Ohne ihn antworten die Routen mit 503.
   */
  engines?: EnginePort;
  /**
   * Slash-Befehle (Issue #74): Beginnt eine Nachricht mit einem registrierten
   * Befehl, läuft er statt eines Turns; GET /api/commands liefert die Liste.
   * In bot.ts createBotCommands aus ./bot-commands. Ohne ihn geht jede
   * Nachricht an den Chat und /api/commands antwortet mit 503.
   */
  commands?: CommandPort;
  /**
   * Ziele (Issue #76): GET/POST /api/conversations/<id>/goal liefern die
   * Status-Karte bzw. drücken einen ihrer Knöpfe, jede Änderung geht als
   * SSE-Ereignis goal an das Gespräch. In bot.ts createBotGoals aus
   * ./bot-goals. Ohne ihn gibt es keine Karte und POST antwortet mit 503.
   */
  goals?: GoalPort;
  /**
   * Rückfragen aus dem Register (Issue #115): Nachrichten mit choiceId tragen
   * im API-Format choice (Knöpfe, Zustand, Ergebnis), POST
   * /api/conversations/<id>/choices/<choiceId> entscheidet, jede Änderung
   * geht als SSE-Ereignis choice an das Gespräch und den Sammelstrom. In
   * bot.ts createBotChoices aus ./bot-choices. Ohne ihn keine Knöpfe,
   * die Route antwortet mit 503.
   */
  choices?: ChoicePort;
  /**
   * Schlüssel (Issue #62): GET /api/keys, PUT und DELETE /api/keys/<name>
   * nach den Schutzregeln in ./keys. In bot.ts createBotKeys aus
   * ./bot-keys, in web:dev und Demo createDemoKeys (nur im Speicher).
   * Ohne ihn antworten die Routen mit 503.
   */
  keys?: KeysPort;
  /**
   * Web Push (Issue #225): VAPID-Schlüssel und Kontakt, in bot.ts aus
   * prepareBotPush (./bot-push). Abos in <dataDir>/push-subscriptions.json.
   * Ohne ihn meldet GET /api/push available: false, die übrigen Routen 503.
   */
  push?: PushDeps;
  /**
   * Meldungen für reine Web-Gespräche (Issue #227): Einträge unter web:<uuid>
   * aus dem Nachrichtenspeicher (notify, Jobs, pipeline-say mit
   * TYBO_CONVERSATION_ID) übernimmt der Server in das Web-Gespräch, höchstens
   * einmal, und holt nach einem Neustart nach (Zeitpunkt in
   * <dataDir>/notice-cursor.json). In bot.ts getDisplayOnlyPage und
   * onMessageSaved; ohne sie keine Übernahme.
   */
  webNotices?: Pick<WebNoticeImportDeps, "page" | "onMessageSaved" | "intervalMs" | "every"> & { cursorFile?: string };
  /**
   * Anhänge aus dem Web-Chat (Issue #72): POST /api/conversations/<id>/attachments,
   * attachments in POST .../messages und der Download. In bot.ts eine
   * UploadStore auf data/uploads, dieselbe wie im Telegram-Turn. Der Server
   * startet ihr stündliches Aufräumen und hält es beim Stopp an. Ohne sie
   * antwortet der Upload mit 503 und Nachrichten mit Anhängen mit 400.
   */
  uploads?: UploadStore;
  /**
   * Nur für Tests: Abruf der Access-Schlüssel (Issue #99) als Attrappe.
   * Standard ist der echte Abruf bei <team>.cloudflareaccess.com.
   */
  accessCerts?: FetchCerts;
  /**
   * Nur für Tests und den Browser-Durchlauf: feste Oberflächen-Version
   * (Issue #111) statt der beim Start aus publicDir berechneten.
   */
  uiVersion?: string;
  /** Abstand der SSE-Keepalive-Kommentare, Standard 20 Sekunden */
  keepaliveMs?: number;
  now?: () => number;
  /** Nie Passwort oder Token übergeben */
  log?: (message: string) => void;
  /**
   * Nur für Screenshots aus web:dev (WEB_DEV_DEMO=1), src/bot.ts setzt das nie:
   * Anfragen ohne Session gelten als angemeldet. Startet nur auf 127.0.0.1.
   * Passwort, Host- und Origin-Prüfung bleiben; Daten gehören in ein eigenes
   * Verzeichnis (siehe src/web/demo.ts).
   */
  demo?: boolean;
}

/** Nachricht von außerhalb eines Turns in ein reines Web-Gespräch (Issue #117) */
export interface ConversationPost {
  text: string;
  /** Meldung (mit source) statt Antwort */
  kind?: "notice";
  source?: string;
  /** Rückfrage aus dem Register, deren Knöpfe unter der Nachricht stehen */
  choiceId?: string;
}

export interface WebServer {
  url: string;
  /** Offene SSE-Verbindungen (für Tests) */
  eventStreamCount(): number;
  /** Meldet ein Tab dieses Gespräch gerade als sichtbar (Issue #226, für Tests) */
  isConversationVisible(conversationId: string): boolean;
  /**
   * Legt eine Nachricht in einem reinen Web-Gespräch ab und schickt sie an
   * dessen offene Browser (Issue #117: Merk-Vorschläge und ihr Ergebnis).
   * Läuft dort ein Turn, erst danach. false, wenn es das Gespräch nicht gibt
   * oder der Server beendet wird; sonst true, ohne auf den Turn zu warten.
   */
  postToConversation(conversationId: string, post: ConversationPost): Promise<boolean>;
  /**
   * Nimmt keine neuen Turns mehr an, bricht laufende ab, wartet begrenzt auf
   * deren Abschlussmeldung und schließt dann SSE-Verbindungen und Server.
   */
  stop(options?: ChatShutdownOptions): Promise<void>;
}

class BodyTooLarge extends Error {}

/**
 * Liest den Body und behält höchstens `limit` Bytes. Was darüber hinausgeht,
 * wird verworfen, aber zu Ende gelesen: Bricht der Server mitten im Body ab,
 * liest Bun die Reste als neue Anfrage und antwortet darauf selbst (400/431,
 * ohne Sicherheits-Kopfzeilen). Das Verwerfen kostet keinen Speicher.
 */
async function readLimitedBytes(req: Request, limit: number): Promise<Buffer> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= limit) chunks.push(value);
  }
  if (size > limit) throw new BodyTooLarge();
  return Buffer.concat(chunks);
}

async function readLimitedText(req: Request, limit: number): Promise<string> {
  return (await readLimitedBytes(req, limit)).toString("utf8");
}

/** Body ungelesen verwerfen (siehe readLimitedText: zu Ende lesen, nichts behalten) */
async function discardBody(req: Request): Promise<void> {
  try {
    await readLimitedBytes(req, 0);
  } catch {
    // zu groß oder abgebrochen: egal, er wird nicht gebraucht
  }
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Secure nur über den Tunnel (https); im Heimnetz läuft http, dort würde der Browser es verwerfen */
function sessionCookie(token: string, maxAgeSeconds: number, secure = false): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function tooLarge(): Response {
  return json({ error: "Anfrage zu groß" }, 413);
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "Methode nicht erlaubt" }, 405, { Allow: allow });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/**
 * Löst einen URL-Pfad sicher unter `publicDir` auf. null bei allem, was
 * nach Traversal, versteckter Datei oder ungewöhnlichen Zeichen aussieht.
 */
async function resolvePublicFile(publicDir: string, urlPath: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(decoded)) return null;
  const segments = decoded.split("/").slice(1);
  if (segments.some(s => s === "" || s.startsWith("."))) return null;
  const root = await realpath(publicDir).catch(() => null);
  if (!root) return null;
  const candidate = resolve(root, ...segments);
  if (!candidate.startsWith(root + sep)) return null;
  const real = await realpath(candidate).catch(() => null);
  if (!real || !real.startsWith(root + sep)) return null;
  const info = await stat(real).catch(() => null);
  return info?.isFile() ? real : null;
}

async function serveFile(publicDir: string, urlPath: string, uiVersion: string): Promise<Response | null> {
  const file = await resolvePublicFile(publicDir, urlPath);
  if (!file) return null;
  // Name aus src/brand.ts in Titel und Wortmarke (Issue #100), Oberflächen-Version (Issue #111)
  if (extname(file).toLowerCase() === ".html") return brandHtmlResponse(file, uiVersion);
  // Service Worker (Issue #224): Version und Name eingesetzt, neue Bytes je Oberflächen-Version
  if (urlPath === SERVICE_WORKER_PATH) return serviceWorkerResponse(file, uiVersion);
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  return new Response(Bun.file(file), { headers: { "Content-Type": type } });
}

export const DEMO_HOST = "127.0.0.1";

export async function createWebServer(config: WebConfig, deps: WebServerDeps = {}): Promise<WebServer> {
  // Vor allem anderen: der Demo-Modus darf nie im Netz erreichbar sein
  if (deps.demo && config.host !== DEMO_HOST) {
    throw new Error(`Demo-Modus nur auf ${DEMO_HOST}, nicht auf ${config.host}`);
  }
  const publicDir = deps.publicDir ?? DEFAULT_PUBLIC_DIR;
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  // Einmal beim Start (Issue #111); ohne lesbares publicDir keine Version, dann kein Hinweis
  let uiVersion = deps.uiVersion ?? "";
  if (deps.uiVersion === undefined) {
    try {
      uiVersion = await computeUiVersion(publicDir);
    } catch (e) {
      log(`Oberflächen-Version nicht berechenbar (${e instanceof Error ? e.name : typeof e})`);
    }
  }
  const sessions = new SessionStore({ file: deps.sessionFile, now: deps.now });
  await sessions.load();
  // Demo: eine eigene Session, die für Anfragen ohne gültiges Cookie gilt,
  // damit auch die SSE-Verbindung an eine echte Session gebunden ist
  const demoToken = deps.demo ? await sessions.create() : null;
  if (deps.demo) log("Demo-Modus: ohne Anmeldung, nur auf 127.0.0.1");
  const limiter = new LoginLimiter({ now: deps.now });
  const now = deps.now ?? Date.now;
  // Zweites Schloss (Issue #99): ohne Access-Einstellungen gibt es keinen
  // Prüfer, und getunnelte Anfragen scheitern immer (sicherer Ausfall)
  const accessVerifier = config.access
    ? createAccessVerifier({ access: config.access, fetchCerts: deps.accessCerts, now, log })
    : null;
  // Weg von unterwegs (Issue #231): Tailscale nur für eine ts.net-Adresse ohne Access-Werte
  const remote = remoteKind(config);
  if (remote === "cloudflare" && !accessVerifier) {
    log("WEB_PUBLIC_ORIGIN ist gesetzt, Cloudflare Access aber nicht (WEB_ACCESS_TEAM, WEB_ACCESS_AUD): Anfragen über den Tunnel werden abgelehnt");
  }
  if (remote === "tailscale") log("Zugang von unterwegs über Tailscale (WEB_PUBLIC_ORIGIN), Anmeldung mit dem WebUI-Passwort");
  const accessLogged = new Map<string, number>();
  /** Nur Ergebnis und Grund, nie das Token; gleiche Meldungen gebremst */
  function logAccess(who: string, result: AccessResult): void {
    const line = result.ok ? `Access ok für ${who}` : `Access abgelehnt für ${who}: ${ACCESS_REASON_TEXT[result.reason]}`;
    const t = now();
    const last = accessLogged.get(line);
    if (last !== undefined && t - last < ACCESS_LOG_INTERVAL_MS) return;
    if (accessLogged.size > 500) accessLogged.clear();
    accessLogged.set(line, t);
    log(line);
  }
  // Anwesenheit (Issue #226): welches Gespräch gerade auf einem Tab sichtbar offen ist, nur im Speicher
  const presence = new PresenceTracker({ now });
  const store = deps.conversationStore ?? new ConversationStore({ dir: deps.dataDir, now: deps.now });
  if (!deps.conversationStore) await store.load();
  /**
   * Rückfrage einer Nachricht (Issue #115): choiceId wird durch choice mit dem
   * Zustand aus dem Register ersetzt, aus Sicht genau dieses Gesprächs. Ohne
   * Port fällt choiceId weg; wirft, wenn das Register nicht lesbar ist. Dann
   * behalten Verlauf und SSE nur choiceId, und der Browser holt den Stand
   * über die Stand-Abfrage nach.
   */
  async function decorateMessage(conversationId: string, message: ApiMessage): Promise<ApiMessage> {
    const { choiceId, choice: _choice, ...rest } = message;
    if (!choiceId || !deps.choices) return rest;
    return { ...rest, choice: await deps.choices.view(choiceId, conversationId) };
  }
  /**
   * Verlauf: alle Nachrichten ergänzen. Ist eine Rückfrage nicht lesbar, bleibt
   * nur ihre Kennung (choiceId, ohne choice): der Browser behält den bisherigen
   * Stand und fragt ihn nach, bis das Register wieder lesbar ist.
   */
  async function decorateAll<T extends ApiMessage>(conversationId: string, messages: T[]): Promise<ApiMessage[]> {
    let failed = false;
    const out = await Promise.all(
      messages.map(m =>
        decorateMessage(conversationId, m).catch(() => {
          failed = true;
          const { choice: _choice, ...rest } = m;
          return rest;
        })
      )
    );
    if (failed) log(`Rückfragen im Verlauf von ${conversationId} nicht lesbar`);
    return out;
  }
  /** Push von selbst (Issue #226); gesetzt, sobald die Abos geladen sind, ohne Push nie */
  let notifier: PushNotifier | null = null;
  /** Fertige Antwort eines Turns aus einem der Hubs: Push, wenn das Gespräch nirgends sichtbar ist */
  const onReply = (event: { conversationId: string; text: string; agent?: string; source: MessageSource }) => {
    void notifier?.reply({ conversationId: event.conversationId, text: event.text, agent: event.agent, origin: event.source });
  };
  const hub = new ChatHub({ store, chat: deps.chat, keepaliveMs: deps.keepaliveMs, log, decorate: decorateMessage, onReply });
  const catalog = deps.agentCatalog;
  const agentSource = deps.agents ?? (catalog ? () => catalog.list().map(a => ({ name: a.name })) : FALLBACK_AGENT_NAMES.map(name => ({ name })));
  const currentAgents = (): AgentInfo[] => agentList(typeof agentSource === "function" ? agentSource() : agentSource);
  // Wie ein Set, aber bei jeder Abfrage aktuell
  const agentNames = { has: (name: string) => currentAgents().some(a => a.name === name) };
  const settingsApi = deps.settings ? createSettingsApi(deps.settings, log) : null;
  const models = deps.models ?? createModelCatalog({ log, ...(deps.opencodeModels ? { opencode: deps.opencodeModels } : {}) });
  const agentsApi = catalog ? createAgentsApi({ port: catalog, settingsApi, settingsPort: deps.settings, log }) : null;
  const instructionsApi = deps.instructions ? createInstructionsApi(deps.instructions, agentNames, log) : null;
  const statusApi = deps.status ? createStatusApi(deps.status, log) : null;
  // „Auf Standard" (Issue #126): bei Gesprächen der WebUI wie /motor standard unter der Sperre des Gesprächs
  const enginesApi = deps.engines
    ? createEnginesApi(
        deps.engines,
        {
          conversations: () => engineConversations(),
          resetConversation: deps.resetConversation
            ? async (id, write) => {
                const reset = deps.resetConversation!;
                const result = await hubFor(id).exclusive(id, () => reset(id, write));
                if (result.status !== "done") return result.status;
                if (result.value.status === "busy") return "busy";
                // Kein Session-Schlüssel ermittelbar: beweist nicht, dass keine Antwort läuft, nichts schreiben
                if (result.value.status === "unavailable") return "unavailable";
                return "done";
              }
            : undefined,
        },
        log
      )
    : null;
  // Nie mit unlocked: Sperren aufheben darf nur der Einrichtungsmodus (M8) intern
  const keysApi = deps.keys ? createKeysApi(deps.keys, log) : null;
  // Web Push (Issue #225): Abos pro Gerät neben den Gesprächen
  let pushApi: ReturnType<typeof createPushApi> | null = null;
  if (deps.push) {
    const pushStore = new PushSubscriptionStore({
      file: deps.push.file ?? PushSubscriptionStore.fileIn(deps.dataDir ?? DEFAULT_DATA_DIR),
      now: deps.now,
      telegram: deps.push.telegram,
    });
    await pushStore.load();
    const api = createPushApi(pushStore, deps.push, log);
    pushApi = api;
    notifier = createPushNotifier({
      devices: () => pushStore.list(),
      send: (device, message, options) => api.send(device, message, options),
      isVisible: id => presence.isVisible(id),
      title: id => conversationTitleFor(id),
      now,
      log,
    });
  }
  // Telegram-Gespräche: eigener Hub, Nachrichten speichert der Turn in Supabase
  const telegramHub = new ChatHub({
    store: createTelegramMessageLog(deps.now),
    chat: deps.telegramChat,
    keepaliveMs: deps.keepaliveMs,
    log,
    publishUserMessages: true,
    decorate: decorateMessage,
    onReply,
  });
  const hubs = [hub, telegramHub];
  const hubFor = (id: string) => (parseTelegramConversationId(id) ? telegramHub : hub);
  // Rückfragen (Issue #115): neuer Zustand an die Zuhörer des Gesprächs (Knöpfe und Ergebnis),
  // bei Fragen aus Web-Gesprächen auch an den Direktchat (Kopie ohne Knöpfe), an den
  // Sammelstrom nur Gespräch, Kennung und Zustand
  let stopChoices: (() => void) | null = null;
  if (deps.choices) {
    try {
      stopChoices = deps.choices.subscribe((change: ChoiceChange) => {
        const owner = change.conversationId;
        // Neue Frage (Issue #226): nur Push, die Knöpfe bringt die Nachricht dazu; die Kopie im Direktchat pusht nicht
        if (change.created) {
          if (owner) void notifier?.choice({ conversationId: owner, choiceId: change.choice.id, ...(change.kind ? { kind: change.kind } : {}) });
          return;
        }
        if (owner) hubFor(owner).publishChoice(owner, { conversationId: owner, choice: change.choice });
        if (change.copyInDm && owner !== "dm") {
          telegramHub.publishChoice("dm", { conversationId: "dm", choice: choiceViewFor(change.choice, owner, "dm") });
        }
        if (owner) telegramHub.publishChoice(ACTIVITY_STREAM, { conversationId: owner, id: change.choice.id, state: change.choice.state });
      });
    } catch (e) {
      log(`Rückfragen-Änderungen nicht verfügbar (${errorName(e)})`);
    }
  }
  // Nachrichten aus Telegram: Inhalt nur an Zuhörer genau dieses Gesprächs,
  // an alle Seitenleisten nur ID und Zeitpunkt
  // Ziele (Issue #76): jede Änderung an die Zuhörer genau dieses Gesprächs, auch aus Telegram und laufender Arbeit
  let stopGoals: (() => void) | null = null;
  if (deps.goals) {
    try {
      stopGoals = deps.goals.subscribe((id, card) => telegramHub.publishGoal(id, card));
    } catch (e) {
      log(`Ziel-Änderungen nicht verfügbar (${e instanceof Error ? e.name : typeof e})`);
    }
  }
  let stopLive: (() => void) | null = null;
  if (deps.telegramLive) {
    try {
      stopLive = deps.telegramLive.subscribe(event => {
        if (event.message) telegramHub.publishMessage(event.conversationId, event.message);
        // Meldungen pushen (Issue #226); Antworten aus Telegram meldet Telegram selbst
        const m = event.message;
        if (m?.kind === "notice") {
          void notifier?.notice({
            conversationId: event.conversationId,
            text: m.text,
            ...(m.source ? { source: m.source } : {}),
            ...(m.file ? { file: { name: m.file.name } } : {}),
            ...(m.choiceId || m.choice ? { choiceId: m.choiceId ?? m.choice!.id } : {}),
          });
        }
        telegramHub.publishActivity(ACTIVITY_STREAM, { id: event.conversationId, lastActivity: event.at });
      });
    } catch (e) {
      log(`Live-Nachrichten aus Telegram nicht verfügbar (${e instanceof Error ? e.name : typeof e})`);
    }
  }
  // Meldungen für reine Web-Gespräche (Issue #227): aus dem Nachrichtenspeicher übernehmen,
  // entdoppelt über die msgId, mit Push wie jede Meldung
  let stopWebNotices: (() => void) | null = null;
  if (deps.webNotices) {
    const importDeps = deps.webNotices;
    const cursorFile = importDeps.cursorFile ?? join(store.dir, "notice-cursor.json");
    const importNotice = async (conversationId: string, notice: WebNotice) => {
      const stored = await store.appendNoticeOnce(
        conversationId,
        {
          role: "assistant",
          text: notice.text,
          kind: "notice",
          ...(notice.source ? { source: notice.source } : {}),
          ...(notice.file ? { file: notice.file } : {}),
          ...(notice.choiceId ? { choiceId: notice.choiceId } : {}),
        },
        notice.id
      );
      if (!stored) return;
      hub.publishMessage(conversationId, toApiMessage(stored));
      void notifier?.notice({
        conversationId,
        text: stored.text,
        ...(notice.source ? { source: notice.source } : {}),
        ...(notice.file ? { file: { name: notice.file.name } } : {}),
        ...(notice.choiceId ? { choiceId: notice.choiceId } : {}),
      });
    };
    stopWebNotices = startWebNoticeImport({
      conversationIds: async () => (await store.listConversations()).map(c => c.id),
      page: importDeps.page,
      ...(importDeps.onMessageSaved ? { onMessageSaved: importDeps.onMessageSaved } : {}),
      post: importNotice,
      cursor: {
        read: async () => {
          try {
            const parsed = JSON.parse(await readFile(cursorFile, "utf8"));
            return typeof parsed?.at === "string" ? parsed.at : null;
          } catch {
            return null;
          }
        },
        write: async at => {
          const tmp = `${cursorFile}.${process.pid}.tmp`;
          await mkdir(dirname(cursorFile), { recursive: true, mode: 0o700 });
          await writeFile(tmp, JSON.stringify({ at }), { mode: 0o600 });
          await rename(tmp, cursorFile);
        },
      },
      ...(importDeps.intervalMs ? { intervalMs: importDeps.intervalMs } : {}),
      ...(importDeps.every ? { every: importDeps.every } : {}),
      log,
    });
  }
  // In Telegram umbenannte oder angelegte Topics (Issue #32): an alle Seitenleisten nur die ID
  let stopTopicChanges: (() => void) | null = null;
  if (deps.telegramLive?.subscribeTopicChanges) {
    try {
      stopTopicChanges = deps.telegramLive.subscribeTopicChanges(event => {
        telegramHub.publishTopicChange(ACTIVITY_STREAM, event.conversationId);
      });
    } catch (e) {
      log(`Topic-Änderungen aus Telegram nicht verfügbar (${e instanceof Error ? e.name : typeof e})`);
    }
  }
  // Motor-Einstellungen geändert (Issue #126), gleich aus welchem Kanal: an alle Seitenleisten ohne Inhalt
  let stopEngineChanges: (() => void) | null = null;
  if (deps.engines?.subscribe) {
    try {
      stopEngineChanges = deps.engines.subscribe(() => telegramHub.publishEngineChange(ACTIVITY_STREAM));
    } catch (e) {
      log(`Motor-Änderungen nicht verfügbar (${errorName(e)})`);
    }
  }
  // Automatische Titel neuer Topics aus der ersten Nutzernachricht (Issue #29), einmal pro Server
  let stopAutoTitle: (() => void) | null = null;
  if (deps.topics) {
    try {
      stopAutoTitle = deps.topics.startAutoTitle();
    } catch (e) {
      log(`Automatische Topic-Titel nicht verfügbar (${e instanceof Error ? e.name : typeof e})`);
    }
  }
  /** Terminal-Zugang (Issue #59), gesetzt nach dem Start des Servers */
  let cliToken: CliToken | null = null;
  // Der tatsächliche Port steht erst nach dem Start fest (Port 0 in Tests)
  const hostCheck = { port: config.port, allowedHosts: config.allowedHosts };

  function errorName(e: unknown): string {
    return e instanceof Error ? e.name : typeof e;
  }

  /** Fehler der Quelle ergeben leere Listen und eine Log-Zeile, keinen 500 */
  async function listTelegram(): Promise<TelegramConversationList> {
    if (!deps.telegram) return { dm: null, topics: [] };
    try {
      return await deps.telegram.listConversations();
    } catch (e) {
      log(`Telegram-Gespräche nicht lesbar (${errorName(e)})`);
      return { dm: null, topics: [] };
    }
  }

  /** Titel eines Gesprächs für Benachrichtigungen (Issue #226); leer, wenn unbekannt */
  async function conversationTitleFor(id: string): Promise<string> {
    if (parseTelegramConversationId(id)) {
      const telegram = await listTelegram();
      if (id === "dm") return telegram.dm?.title ?? "";
      return telegram.topics.find(t => t.id === id)?.title ?? "";
    }
    return (await store.getConversation(id))?.title ?? "";
  }

  /** Alle Gespräche der WebUI mit Namen, für die Motor-Ausnahmen (Issue #126) */
  async function engineConversations(): Promise<EngineConversation[]> {
    const telegram = await listTelegram();
    const out: EngineConversation[] = [];
    if (telegram.dm) out.push({ id: telegram.dm.id, title: telegram.dm.title });
    for (const t of telegram.topics) out.push({ id: t.id, title: t.title });
    for (const c of await store.listConversations()) out.push({ id: c.id, title: c.title });
    return out;
  }

  /** Motor je Gespräch und Standard für GET /api/conversations (Issue #126); ohne Port nichts */
  function withEngines<T extends { id: string }>(list: T[]): (T & { engine?: string })[] {
    if (!deps.engines) return list;
    try {
      const engines = conversationEngines(deps.engines, list.map(c => c.id));
      return list.map(c => ({ ...c, engine: engines[c.id] }));
    } catch (e) {
      log(`Motor je Gespräch nicht ermittelbar (${errorName(e)})`);
      return list;
    }
  }

  function engineSummary(): { default: string } | undefined {
    if (!deps.engines) return undefined;
    try {
      return { default: deps.engines.standard().engine };
    } catch {
      return undefined;
    }
  }

  function groupChatId(): string | null {
    try {
      const id = deps.telegram?.groupChatId?.();
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * Neue Nachricht (POST .../messages) für Web- und Telegram-Gespräche:
   * Prüfen, dann an den zuständigen Hub.
   */
  async function postMessage(target: ChatHub, conversation: HubConversation, body: string, source: MessageSource): Promise<Response> {
    let text: unknown;
    let approvalId: unknown;
    let attachments: unknown;
    try {
      const parsed = JSON.parse(body);
      text = parsed && typeof parsed === "object" ? parsed.text : undefined;
      approvalId = parsed && typeof parsed === "object" ? parsed.approvalId : undefined;
      attachments = parsed && typeof parsed === "object" ? parsed.attachments : undefined;
    } catch {
      return json({ error: "Ungültige Anfrage" }, 400);
    }
    // Eine leere Liste heißt: keine Anhänge
    if (attachments !== undefined && !(Array.isArray(attachments) && attachments.length === 0)) {
      return postWithAttachments(target, conversation, text, approvalId, attachments, source);
    }
    const invalid = validateMessageText(text);
    if (invalid) return json({ error: invalid }, 400);
    // Antwort auf eine Rückfrage: Kennung der angezeigten Frage
    if (approvalId !== undefined && (typeof approvalId !== "string" || !approvalId || approvalId.length > 100)) {
      return json({ error: "Feld approvalId ist ungültig" }, 400);
    }
    // Befehl statt Turn (Issue #74); eine Antwort auf eine Rückfrage ist kein Befehl, außer /stop
    const command = matchCommand(text as string, source);
    if (command && (approvalId === undefined || command.whileBusy)) {
      return runCommandMessage(target, conversation, text as string, source, command);
    }
    if (!target.available) return json({ error: "Chat ist nicht verfügbar" }, 503);
    const result = await target.send(conversation, text as string, approvalId as string | undefined, source);
    if (result.status === "busy") return json({ error: "In diesem Gespräch läuft schon eine Antwort" }, 409);
    if (result.status === "stale") {
      return json({ error: "Diese Freigabe-Frage ist nicht mehr offen, die Antwort wurde nicht übernommen.", stale: true }, 409);
    }
    if (result.status === "closing") return json({ error: "Die WebUI wird gerade beendet" }, 503);
    return json({ message: result.message }, 202);
  }

  /**
   * Nachricht mit Anhängen (Issue #72, in Web-Gesprächen seit #112): nie als
   * Antwort auf eine Rückfrage und nie mit einem Befehl (sonst gingen die
   * Anhänge still verloren: 400). Text darf leer sein. Die IDs werden erst
   * angenommen (claim, nur IDs genau dieses Gesprächs), dann läuft der Turn;
   * wird die Nachricht nicht angenommen (busy, closing, Fehler), sind sie
   * wieder frei. Web-Gespräche spiegeln nichts nach Telegram.
   */
  async function postWithAttachments(
    target: ChatHub,
    conversation: HubConversation,
    rawText: unknown,
    approvalId: unknown,
    ids: unknown,
    source: MessageSource
  ): Promise<Response> {
    const text = rawText === undefined ? "" : rawText;
    const invalid = validateMessageText(text, { allowEmpty: true });
    if (invalid) return json({ error: invalid }, 400);
    if (approvalId !== undefined) return json({ error: UPLOAD_TEXT.withAnswer }, 400);
    const invalidIds = validateIds(ids);
    if (invalidIds) return json({ error: invalidIds }, 400);
    if ((text as string).trim() && matchCommand(text as string, source)) return json({ error: UPLOAD_TEXT.withCommand }, 400);
    const uploads = deps.uploads;
    if (!uploads) return json({ error: UPLOAD_TEXT.notConfigured }, 400);
    if (!target.available) return json({ error: "Chat ist nicht verfügbar" }, 503);
    const claimed = await uploads.claim(conversation.id, ids);
    if (!claimed.ok) return json({ error: claimed.error }, 400);
    const release = () => uploads.unclaim(conversation.id, ids as string[]);
    const withUrls: ApiAttachment[] = claimed.attachments.map(a => toApiAttachment(conversation.id, a));
    let result;
    try {
      result = await target.send(conversation, text as string, undefined, source, withUrls);
    } catch (e) {
      await release();
      throw e;
    }
    if (result.status !== "started") await release();
    if (result.status === "busy") return json({ error: "In diesem Gespräch läuft schon eine Antwort" }, 409);
    if (result.status === "closing") return json({ error: "Die WebUI wird gerade beendet" }, 503);
    if (result.status === "stale") return json({ error: "Ungültige Anfrage" }, 400);
    return json({ message: result.message }, 202);
  }

  /** Befehl zu einer Nachricht; ohne Port oder bei einem Fehler des Ports keiner */
  function matchCommand(text: string, source: MessageSource): CommandMatchInfo | null {
    if (!deps.commands) return null;
    try {
      return deps.commands.match(text, source);
    } catch (e) {
      log(`Befehlserkennung fehlgeschlagen (${errorName(e)})`);
      return null;
    }
  }

  /**
   * Slash-Befehl (Issue #74): Nachricht ablegen, Befehl ausführen, Antworten
   * als Meldungen. 202 wie bei einer Nachricht, dazu running: läuft danach
   * noch etwas im Gespräch (bei /stop meist nicht mehr).
   */
  async function runCommandMessage(
    target: ChatHub,
    conversation: HubConversation,
    text: string,
    source: MessageSource,
    command: CommandMatchInfo
  ): Promise<Response> {
    const port = deps.commands!;
    const result = await target.sendCommand(
      conversation,
      text,
      execution =>
        port.run({ ...execution, conversationId: conversation.id, agent: conversation.agent, text, source, ...(conversation.title ? { title: conversation.title } : {}) }),
      { whileBusy: command.whileBusy }
    );
    if (result.status === "busy") return json({ error: "In diesem Gespräch läuft schon eine Antwort" }, 409);
    if (result.status === "closing") return json({ error: "Die WebUI wird gerade beendet" }, 503);
    return json({ message: result.message, running: result.running, command: command.name }, 202);
  }

  /**
   * Live-Ereignisse, an die Anmeldung gebunden: nach Abmelden, Ablauf oder
   * (Terminal) Stopp des Servers keine Daten mehr
   */
  function events(target: ChatHub, id: string, req: Request, auth: RequestAuth, keepOpen: () => void): Response {
    keepOpen();
    return target.subscribe(id, req.signal, {
      session: auth.session,
      isAuthorized: () => auth.isAuthorized(),
    });
  }

  /**
   * POST /api/conversations/<id>/reset (Issue #61): Session frisch starten
   * wie /new in Telegram, der Verlauf bleibt. Unter der Sperre des Hubs: eine
   * laufende Antwort (auch mit offener Rückfrage) oder eine gleichzeitig
   * geschickte Nachricht ergibt 409; Antworten aus Telegram prüft der Port.
   */
  async function resetConversationSession(target: ChatHub, id: string, method: string): Promise<Response> {
    if (method !== "POST") return methodNotAllowed("POST");
    const reset = deps.resetConversation;
    if (!reset) return json({ error: SESSION_RESET_TEXT.notConfigured }, 503);
    let result;
    try {
      result = await target.exclusive(id, () => reset(id));
    } catch (e) {
      log(`Session von Gespräch ${id} nicht zurückgesetzt (${errorName(e)})`);
      return json({ error: SESSION_RESET_TEXT.failed }, 500);
    }
    if (result.status === "busy") return json({ error: SESSION_RESET_TEXT.busy }, 409);
    if (result.status === "closing") return json({ error: "Die WebUI wird gerade beendet" }, 503);
    const value = result.value;
    if (value.status === "busy") return json({ error: SESSION_RESET_TEXT.busy }, 409);
    if (value.status === "unavailable") return json({ error: SESSION_RESET_TEXT.unavailable }, 503);
    log(`Session von Gespräch ${id} zurückgesetzt (${value.reset})`);
    return json({ reset: value.reset, sessionMode: value.sessionMode, note: sessionResetNote(value) });
  }

  /**
   * Telegram-Gespräche: Verlauf aus dem Nachrichtenspeicher, Schreiben,
   * Stoppen und Live-Ereignisse über den eigenen Hub (Issue #19).
   */
  async function telegramRoutes(
    req: Request,
    id: string,
    action: string | undefined,
    method: string,
    body: string,
    auth: RequestAuth,
    keepOpen: () => void
  ): Promise<Response> {
    let conversation: TelegramConversation | null = null;
    if (deps.telegram) {
      try {
        conversation = await deps.telegram.getConversation(id);
      } catch (e) {
        log(`Telegram-Gespräch nicht lesbar (${errorName(e)})`);
      }
    }
    if (!conversation) return json({ error: "Gespräch nicht gefunden" }, 404);
    const ref = parseTelegramConversationId(id)!;
    // Direktchat und General lassen sich nicht verwalten (Entscheidung 0005), die Prüfung davor gilt schon
    const topicId = ref.kind === "topic" ? ref.topicId : 0;

    if (!action) {
      if (method === "PATCH") return updateTopic(conversation, topicId, body);
      if (method === "DELETE") return deleteTopic(id, conversation, topicId, body);
      if (method !== "GET") return methodNotAllowed(topicId > 1 ? "GET, PATCH, DELETE" : "GET");
      return json({ conversation, ...telegramHub.status(id) });
    }
    if (action === "close" || action === "reopen") {
      if (method !== "POST") return methodNotAllowed("POST");
      const result = await deps.topics!.setClosed(conversation, topicId, action === "close");
      return json(result.body, result.status);
    }
    if (action === "messages") {
      if (method === "POST") {
        // Vorsichtig: der Bot könnte als Admin noch posten, die WebUI tut es nicht
        if (conversation.closed) return json({ error: TOPIC_TEXT.closed, closed: true }, 409);
        return postMessage(telegramHub, conversation, body, auth.source);
      }
      if (method !== "GET") return methodNotAllowed("GET, POST");
      const rawBefore = new URL(req.url).searchParams.get("before");
      let before: string | undefined;
      if (rawBefore !== null) {
        before = parseBeforeCursor(rawBefore) ?? undefined;
        if (!before) return json({ error: "Parameter before ist kein gültiger Zeitpunkt" }, 400);
      }
      try {
        const history = await deps.telegram!.history(id, before);
        if (!history) return json({ error: "Gespräch nicht gefunden" }, 404);
        return json({ messages: await decorateAll(id, history.messages), hasMore: history.hasMore, ...telegramHub.status(id) });
      } catch (e) {
        // Kein leerer Verlauf mit 200: für einen Abgleich hieße das „nichts verpasst“
        log(`Telegram-Verlauf nicht lesbar (${errorName(e)})`);
        return json({ error: "Telegram-Verlauf gerade nicht lesbar" }, 503);
      }
    }
    if (action === "events") {
      if (method !== "GET") return methodNotAllowed("GET");
      return events(telegramHub, id, req, auth, keepOpen);
    }
    if (action === "reset") return resetConversationSession(telegramHub, id, method);
    if (action === "goal") return goalRoute(id, method, body);
    // action === "stop"
    if (method !== "POST") return methodNotAllowed("POST");
    return json({ stopping: telegramHub.stop(id) });
  }

  /**
   * GET /api/conversations/<id>/goal: Status-Karte oder { card: null }.
   * POST mit { action, goalId }: Knopf der Karte (Issue #76), wirkt wie der
   * Knopf bzw. Befehl in Telegram. 409 mit stale und aktueller Karte, wenn der
   * Knopf nicht mehr passt (anderes Ziel, schon gedrückt, Zustand gewechselt).
   */
  async function goalRoute(id: string, method: string, body: string): Promise<Response> {
    const port = deps.goals;
    if (method === "GET") {
      if (!port) return json({ card: null });
      try {
        return json({ card: await port.get(id) });
      } catch (e) {
        log(`Ziel von ${id} nicht lesbar (${errorName(e)})`);
        return json({ error: GOAL_CARD_TEXT.failed }, 503);
      }
    }
    if (method !== "POST") return methodNotAllowed("GET, POST");
    if (!port) return json({ error: GOAL_CARD_TEXT.notConfigured }, 503);
    const parsed = parseObject(body);
    const action = parsed?.action;
    const goalId = parsed?.goalId;
    if (!isGoalCardAction(action) || typeof goalId !== "number" || !Number.isSafeInteger(goalId) || goalId <= 0) {
      return json({ error: GOAL_CARD_TEXT.invalid }, 400);
    }
    let outcome;
    try {
      outcome = await port.act(id, action, goalId);
    } catch (e) {
      log(`Ziel-Aktion in ${id} fehlgeschlagen (${errorName(e)})`);
      return json({ error: GOAL_CARD_TEXT.failed }, 500);
    }
    if (outcome.status === "unavailable") return json({ error: GOAL_CARD_TEXT.unavailable }, 503);
    if (outcome.status === "stale") return json({ error: GOAL_CARD_TEXT.stale, stale: true, card: outcome.card }, 409);
    return json({ card: outcome.card });
  }

  /**
   * POST /api/conversations/<id>/choices/<choiceId> mit { option } (Issue
   * #115): entscheidet die Rückfrage wie ein Knopf in Telegram, aber nur,
   * wenn sie zu genau diesem Gespräch gehört (sonst 404, auch für die Kopie
   * einer Web-Frage im Direktchat). Ohne die Sperre des Gesprächs: gerade ein
   * laufender Turn wartet auf diese Entscheidung. Antworten: 200 { choice },
   * 409 { choice, already: true } bzw. { choice, expired: true }, 400 bei
   * fehlender oder unbekannter option, 404 bei unbekannter oder fremder Frage.
   */
  /** Gibt es das Gespräch (Telegram oder Web)? */
  async function choiceConversationExists(conversationId: string): Promise<boolean> {
    if (parseTelegramConversationId(conversationId)) {
      try {
        return !!(deps.telegram && (await deps.telegram.getConversation(conversationId)));
      } catch (e) {
        log(`Telegram-Gespräch nicht lesbar (${errorName(e)})`);
        return false;
      }
    }
    return isConversationId(conversationId) && !!(await store.getConversation(conversationId));
  }

  /**
   * GET /api/conversations/<id>/choices?ids=a,b: aktueller Stand dieser
   * Rückfragen aus Sicht des Gesprächs, wie im Verlauf (unbekannte gelten als
   * abgelaufen). Der Browser fragt damit nach jedem Abgleich die offenen
   * Fragen ab, auch die aus älteren, nachgeladenen Seiten, deren Ereignisse
   * in einer Verbindungslücke verloren gingen. 503, wenn das Register nicht
   * lesbar ist: dann bleibt der bisherige Stand stehen.
   */
  async function choiceSnapshotRoute(conversationId: string, method: string, rawIds: string | null): Promise<Response> {
    if (method !== "GET") return methodNotAllowed("GET");
    if (!(await choiceConversationExists(conversationId))) return json({ error: CHOICE_TEXT.notFound }, 404);
    const port = deps.choices;
    if (!port) return json({ error: CHOICE_TEXT.notConfigured }, 503);
    const ids = [...new Set((rawIds ?? "").split(",").filter(id => isChoiceId(id)))];
    if (ids.length > MAX_CHOICE_SNAPSHOT) return json({ error: CHOICE_TEXT.invalid }, 400);
    try {
      return json({ choices: await Promise.all(ids.map(id => port.view(id, conversationId))) });
    } catch (e) {
      log(`Rückfragen in ${conversationId} nicht lesbar (${errorName(e)})`);
      return json({ error: CHOICE_TEXT.failed }, 503);
    }
  }

  async function choiceRoute(conversationId: string, choiceId: string, method: string, body: string, auth: RequestAuth): Promise<Response> {
    if (method !== "POST") return methodNotAllowed("POST");
    const notFound = () => json({ error: CHOICE_TEXT.notFound }, 404);
    if (!(await choiceConversationExists(conversationId))) return notFound();
    const port = deps.choices;
    if (!port) return json({ error: CHOICE_TEXT.notConfigured }, 503);
    const option = parseObject(body)?.option;
    if (typeof option !== "string" || !option) return json({ error: CHOICE_TEXT.invalid }, 400);
    let result;
    try {
      // Kanal aus der Anmeldung: Browser web, lokaler Schlüssel terminal
      result = await port.decide(conversationId, choiceId, option, auth.source);
    } catch (e) {
      log(`Rückfrage in ${conversationId} nicht entschieden (${errorName(e)})`);
      return json({ error: CHOICE_TEXT.failed }, 500);
    }
    switch (result.status) {
      case "decided":
        return json({ choice: result.choice });
      case "already":
        return json({ error: CHOICE_TEXT.already, choice: result.choice, already: true }, 409);
      case "expired":
        return json({ error: CHOICE_TEXT.expired, choice: result.choice, expired: true }, 409);
      case "invalid_option":
        return json({ error: CHOICE_TEXT.invalid }, 400);
      default:
        return notFound();
    }
  }

  /** JSON-Objekt aus dem Body oder null */
  function parseObject(body: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * PATCH /api/conversations/topic-<n> mit { title } (Issue #29), { agent }
   * oder beidem (Issue #36). Erst alles prüfen, dann umbenennen (Telegram),
   * dann die Zuordnung in config/topics.json schreiben. Scheitert das
   * Umbenennen, bleibt der Agent unverändert.
   */
  async function updateTopic(conversation: TelegramConversation, topicId: number, body: string): Promise<Response> {
    const parsed = parseObject(body);
    if (!parsed) return json({ error: "Ungültige Anfrage" }, 400);
    // Ohne agent wie bisher: nur Umbenennen, Prüfung und Meldungen im Manager
    if (parsed.agent === undefined) {
      const result = await deps.topics!.rename(conversation, topicId, parsed.title);
      return json(result.body, result.status);
    }
    const agent = parsed.agent;
    if (typeof agent !== "string" || !AGENT_NAME_PATTERN.test(agent) || !agentNames.has(agent)) {
      return json({ error: "Ungültiger Agent" }, 400);
    }
    const renaming = parsed.title !== undefined;
    if (renaming && normalizeTopicTitle(parsed.title) === null) {
      return json({ error: `Titel muss 1 bis ${TOPIC_TITLE_MAX_CHARS} Zeichen lang sein, ohne Steuerzeichen` }, 400);
    }
    let current = conversation;
    if (renaming) {
      const renamed = await deps.topics!.rename(conversation, topicId, parsed.title);
      if (renamed.status !== 200) return json(renamed.body, renamed.status);
      current = renamed.body.conversation as TelegramConversation;
    }
    const result = await deps.topics!.setAgent(current, topicId, agent);
    if (result.status !== 200 && renaming) {
      return json({ error: TOPIC_TEXT.renamedAgentNotSaved, conversation: current }, result.status);
    }
    return json(result.body, result.status);
  }

  /**
   * DELETE /api/conversations/topic-<n> mit { confirm: "<Name>" } (Issue #29).
   * Reihenfolge: Name, Recht, dann die Sperre des Hubs (laufende und
   * gleichzeitige Web-Turns ergeben 409) bis nach dem Aufräumen; alles
   * Weitere (Telegram-Ausführungen, Zustand, Löschen, Aufräumen) im Manager.
   * Der Name wird dort unter der Topic-Sperre noch einmal frisch geprüft,
   * damit ein gleichzeitiges Umbenennen den alten Namen ungültig macht.
   */
  async function deleteTopic(id: string, conversation: TelegramConversation, topicId: number, body: string): Promise<Response> {
    const parsed = parseObject(body);
    // Exakt der gespeicherte Name, nicht der getrimmte Anzeigetitel
    const expected = await deps.topics!.exactName(topicId, conversation.title).catch(() => conversation.title);
    if (!parsed || typeof parsed.confirm !== "string" || parsed.confirm !== expected) {
      return json({ error: TOPIC_TEXT.confirmMismatch }, 400);
    }
    const confirm = parsed.confirm;
    const denied = await deps.topics!.checkDeleteRights();
    if (denied) return json(denied.body, denied.status);
    const confirmed = async () => {
      const current = await deps.telegram!.getConversation(id);
      return !!current && (await deps.topics!.exactName(topicId, current.title)) === confirm;
    };
    const result = await telegramHub.exclusive(id, () => deps.topics!.delete(topicId, confirmed));
    if (result.status === "busy") return json({ error: TOPIC_TEXT.busy }, 409);
    if (result.status === "closing") return json({ error: "Die WebUI wird gerade beendet" }, 503);
    // Auch bei unvollständigem Aufräumen: das Topic ist gelöscht, offene Browser erfahren es
    if (result.value.body.deleted === true) telegramHub.closeConversation(id);
    return json(result.value.body, result.value.status);
  }

  /** PATCH /api/conversations/<id> mit { title } (Issue #21) */
  async function renameConversation(id: string, body: string): Promise<Response> {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: "Ungültige Anfrage" }, 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "Ungültige Anfrage" }, 400);
    const title = normalizeCustomTitle(parsed.title);
    if (title === null) return json({ error: "Titel muss 1 bis 80 Zeichen lang sein" }, 400);
    const renamed = await store.renameConversation(id, title);
    if (!renamed) return json({ error: "Gespräch nicht gefunden" }, 404);
    return json({ conversation: renamed });
  }

  /**
   * DELETE /api/conversations/<id> (Issue #21). Anhänge und Arbeitskopien
   * des Gesprächs gehen mit (Issue #112). Die Sperre des Hubs hält vom
   * Prüfen bis nach dem Session-Reset: ein laufender Turn (auch mit offener
   * Rückfrage oder beim Speichern der Antwort) ergibt 409, eine gleichzeitig
   * geschickte Nachricht ebenfalls.
   */
  async function deleteConversation(id: string): Promise<Response> {
    const result = await hub.exclusive(id, async () => {
      if (!(await store.deleteConversation(id))) return false;
      // Anhänge und Arbeitskopien mit dem Gespräch (Issue #112); scheitert das, bleibt es gelöscht
      if (deps.uploads) {
        try {
          await deps.uploads.removeConversation(id);
        } catch (e) {
          log(`Anhänge von Gespräch ${id} nicht gelöscht (${errorName(e)})`);
        }
      }
      if (deps.resetSession) {
        try {
          await deps.resetSession(webSessionKey(id));
        } catch (e) {
          log(`Session von Gespräch ${id} nicht zurückgesetzt (${errorName(e)})`);
        }
      }
      return true;
    });
    if (result.status === "busy") return json({ error: "In diesem Gespräch läuft gerade eine Antwort" }, 409);
    if (result.status === "closing") return json({ error: "Die WebUI wird gerade beendet" }, 503);
    if (!result.value) return json({ error: "Gespräch nicht gefunden" }, 404);
    hub.closeConversation(id);
    return json({ deleted: true });
  }

  /**
   * GET /api/files/<id> (Issue #47): nur ids aus festgehaltenen Einträgen,
   * sonst 404; Auslieferung und Inline-Regeln in ./files.
   */
  async function downloadFile(id: string, inline: boolean): Promise<Response> {
    const notFound = () => json({ error: "Datei nicht gefunden" }, 404);
    if (!deps.files || !OUTBOX_FILE_ID_PATTERN.test(id)) return notFound();
    let file: NoticeFile | null;
    try {
      // Reine Web-Gespräche, die es gibt (Issue #227): Meldungen mit Dateien unter web:<uuid>
      const webIds = (await store.listConversations()).map(c => c.id);
      file = await deps.files.source.find(id, webIds);
    } catch (e) {
      log(`Datei-Eintrag nicht lesbar (${errorName(e)})`);
      return json({ error: "Datei gerade nicht abrufbar" }, 503);
    }
    if (!file || file.id !== id) return notFound();
    const res = await serveOutboxFile(deps.files.dir, file, inline);
    if (!res) {
      log("Datei aus Meldung fehlt in der Ablage oder ist nicht auslieferbar");
      return notFound();
    }
    return res;
  }

  /**
   * Gespräch für Anhänge: Telegram-Gespräche (Direktchat, Topics) und reine
   * Web-Gespräche (Issue #112), die es gibt; sonst 404. closed nur bei
   * geschlossenen Topics.
   */
  async function attachmentConversation(id: string): Promise<{ closed: boolean } | { error: Response }> {
    if (!parseTelegramConversationId(id)) {
      if (isConversationId(id) && (await store.getConversation(id))) return { closed: false };
      return { error: json({ error: "Gespräch nicht gefunden" }, 404) };
    }
    let conversation: TelegramConversation | null = null;
    if (deps.telegram) {
      try {
        conversation = await deps.telegram.getConversation(id);
      } catch (e) {
        log(`Telegram-Gespräch nicht lesbar (${errorName(e)})`);
      }
    }
    if (!conversation) return { error: json({ error: "Gespräch nicht gefunden" }, 404) };
    return { closed: !!conversation.closed };
  }

  /**
   * POST /api/conversations/<id>/attachments (Issue #72): eine Datei als
   * Rohdaten, Name prozentkodiert in X-File-Name. Art, MIME-Typ und Grenze
   * nur aus den Bytes (Medien-Kern); Content-Type wird nicht ausgewertet.
   * Antwort 201 mit { id, name, size, mime, kind }.
   */
  async function uploadAttachment(req: Request, id: string): Promise<Response> {
    const reject = async (res: Response) => {
      await discardBody(req);
      return res;
    };
    const uploads = deps.uploads;
    if (!uploads) return reject(json({ error: UPLOAD_TEXT.notConfigured }, 503));
    const found = await attachmentConversation(id);
    if ("error" in found) return reject(found.error);
    if (found.closed) return reject(json({ error: TOPIC_TEXT.closed, closed: true }, 409));
    const name = parseAttachmentName(req.headers.get(FILE_NAME_HEADER));
    if (name === null) return reject(json({ error: UPLOAD_TEXT.badName }, 400));
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) return reject(tooLarge());
    let bytes: Buffer;
    try {
      bytes = await readLimitedBytes(req, MAX_ATTACHMENT_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) return tooLarge();
      throw e;
    }
    const result = await uploads.save(id, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), name);
    if (!result.ok) return json({ error: result.error }, result.status);
    const a = result.attachment;
    return json({ id: a.id, name: a.name, size: a.size, mime: a.mime, kind: a.kind }, 201);
  }

  /**
   * GET /api/conversations/<id>/attachments/<uploadId> (Issue #72): nur
   * Anhänge dieses Gesprächs aus der Ablage, immer als Anhang mit nosniff;
   * ?inline=1 nur bei Bildern, deren Bytes zum Typ passen (./files).
   */
  async function downloadAttachment(conversationId: string, uploadId: string, inline: boolean): Promise<Response> {
    const notFound = () => json({ error: "Datei nicht gefunden" }, 404);
    const uploads = deps.uploads;
    if (!uploads) return notFound();
    const found = await attachmentConversation(conversationId);
    if ("error" in found) return notFound();
    let meta;
    let dir: string | null;
    try {
      meta = await uploads.find(conversationId, uploadId);
      // Aufgelöster, echter Gesprächsordner unter der Wurzel; ein Symlink dort ergibt 404
      dir = meta && (await uploads.conversationDir(conversationId));
    } catch (e) {
      log(`Anhang nicht lesbar (${errorName(e)})`);
      return json({ error: "Datei gerade nicht abrufbar" }, 503);
    }
    if (!meta || !dir) return notFound();
    const res = await serveOutboxFile(
      dir,
      { id: meta.id, name: UploadStore.storedName(meta), size: meta.size, mime: meta.mime },
      inline,
      meta.name
    );
    return res ?? notFound();
  }

  async function conversationRoutes(
    req: Request,
    path: string,
    method: string,
    body: string,
    auth: RequestAuth,
    keepOpen: () => void
  ): Promise<Response | null> {
    if (path === TELEGRAM_ACTIVITY_PATH) {
      if (method !== "GET") return methodNotAllowed("GET");
      keepOpen();
      return telegramHub.subscribe(ACTIVITY_STREAM, req.signal, {
        session: auth.session,
        isAuthorized: () => auth.isAuthorized(),
        initialStatus: false,
      });
    }
    if (path === TELEGRAM_RIGHTS_PATH) {
      if (method !== "GET") return methodNotAllowed("GET");
      // Ohne Topic-Verwaltung (kein Telegram, Issue #228) gibt es keine Gruppe: Neues Gespräch legt Web-Gespräche an
      if (!deps.topics) return json({ manageTopics: false, deleteMessages: false, group: false });
      const result = await deps.topics.rights();
      return json(result.body, result.status);
    }
    if (path === "/api/settings") {
      if (method !== "GET" && method !== "PATCH") return methodNotAllowed("GET, PATCH");
      if (!settingsApi) return json({ error: SETTINGS_TEXT.notConfigured }, 503);
      const result = method === "GET" ? await settingsApi.get() : await settingsApi.patch(body);
      return json(result.body, result.status);
    }
    if (path === "/api/engines") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!enginesApi) return json({ error: ENGINE_TEXT.notConfigured }, 503);
      const result = await enginesApi.get();
      return json(result.body, result.status);
    }
    if (path === "/api/engines/reset") {
      if (method !== "POST") return methodNotAllowed("POST");
      if (!enginesApi) return json({ error: ENGINE_TEXT.notConfigured }, 503);
      const result = await enginesApi.reset(body);
      return json(result.body, result.status);
    }
    if (path === "/api/status") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!statusApi) return json({ error: STATUS_TEXT.notConfigured }, 503);
      const result = await statusApi.get();
      return json(result.body, result.status);
    }
    if (path === "/api/restart") {
      if (method !== "POST") return methodNotAllowed("POST");
      if (!statusApi) return json({ error: STATUS_TEXT.notConfigured }, 503);
      const result = await statusApi.restart();
      return json(result.body, result.status);
    }
    if (path === "/api/keys") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!keysApi) return json({ error: KEYS_TEXT.notConfigured }, 503);
      // Über den Tunnel nur lesen (Issue #99); pro Anfrage, nie global
      const result = await keysApi.list({ tunneled: auth.tunneled });
      return json(result.body, result.status);
    }
    const keyMatch = KEY_PATH.exec(path);
    if (keyMatch) {
      if (method !== "PUT" && method !== "DELETE") return methodNotAllowed("PUT, DELETE");
      if (!keysApi) return json({ error: KEYS_TEXT.notConfigured }, 503);
      // Name roh aus dem Pfad, ohne Dekodieren: %-Kodierungen fallen durch die Namensprüfung
      const request = { tunneled: auth.tunneled };
      const result =
        method === "PUT" ? await keysApi.put(keyMatch[1], body, request) : await keysApi.remove(keyMatch[1], request);
      return json(result.body, result.status);
    }
    if (path === "/api/push" || path.startsWith("/api/push/")) return pushRoutes(req, path, method, body, auth);
    if (path === PRESENCE_PATH) return presenceRoute(method, body, auth);
    if (path === "/api/commands") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!deps.commands) return json({ error: COMMANDS_TEXT.notConfigured }, 503);
      // Kanal aus der Anmeldung: Browser web, lokaler Schlüssel terminal
      return json({ commands: deps.commands.list(auth.source) });
    }
    if (path === "/api/models") {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await models.list());
    }
    const attachmentMatch = ATTACHMENT_PATH.exec(path);
    if (attachmentMatch) {
      const [, conversationId, uploadId] = attachmentMatch;
      // POST ohne ID beantwortet route() vor dem Lesen des Bodys
      if (uploadId === undefined) return methodNotAllowed("POST");
      if (method !== "GET") return methodNotAllowed("GET");
      return downloadAttachment(conversationId, uploadId, new URL(req.url).searchParams.get("inline") === "1");
    }
    const fileMatch = FILES_PATH.exec(path);
    if (fileMatch) {
      if (method !== "GET") return methodNotAllowed("GET");
      return downloadFile(fileMatch[1], new URL(req.url).searchParams.get("inline") === "1");
    }
    const instructionsMatch = INSTRUCTIONS_PATH.exec(path);
    if (instructionsMatch) {
      const last = !!instructionsMatch[2];
      const allow = last ? "DELETE" : "GET, POST, DELETE";
      if (!allow.split(", ").includes(method)) return methodNotAllowed(allow);
      if (!instructionsApi) return json({ error: INSTRUCTIONS_TEXT.notConfigured }, 503);
      const result = await instructionsApi.handle(instructionsMatch[1], last, method, body);
      return json(result.body, result.status);
    }
    const adminMatch = AGENT_ADMIN_PATH.exec(path);
    if (adminMatch) {
      const action = adminMatch[2];
      const allow = agentAdminMethods(action);
      if (!allow.split(", ").includes(method)) return methodNotAllowed(allow);
      if (!agentsApi) return json({ error: AGENTS_TEXT.notConfigured }, 503);
      const result = await agentsApi.handle(adminMatch[1], action, method, body);
      return json(result.body, result.status);
    }
    if (path === "/api/agents") {
      if (method !== "GET" && method !== "POST") return methodNotAllowed("GET, POST");
      if (method === "POST") {
        if (!agentsApi) return json({ error: AGENTS_TEXT.notConfigured }, 503);
        const result = await agentsApi.create(body);
        return json(result.body, result.status);
      }
      // Mit Katalog: erweiterte Liste (Issue #50), agents und defaultAgent wie bisher
      if (agentsApi) {
        const result = await agentsApi.list();
        return json(result.body, result.status);
      }
      const agents = currentAgents();
      return json({ agents, defaultAgent: agents.some(a => a.name === DEFAULT_AGENT) ? DEFAULT_AGENT : agents[0]?.name ?? null });
    }
    if (path === "/api/conversations") {
      if (method === "GET") {
        const listed = await listTelegram();
        // Motor je Gespräch (Issue #126): eingestellt, nicht der tatsächliche der letzten Antwort
        const telegram: TelegramConversationList & { chatId?: string } = {
          dm: listed.dm ? withEngines([listed.dm])[0] : null,
          topics: withEngines(listed.topics),
        };
        // Chat-ID der Forum-Gruppe, nur wenn bekannt: Topic-Namen in der Löschvorschau (Issue #51)
        const chatId = groupChatId();
        const engine = engineSummary();
        return json({
          conversations: withEngines(await store.listConversations()),
          telegram: chatId ? { ...telegram, chatId } : telegram,
          ...(engine ? { engine } : {}),
        });
      }
      if (method !== "POST") return methodNotAllowed("GET, POST");
      let agent: unknown = DEFAULT_AGENT;
      if (body.trim()) {
        let parsed: any;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json({ error: "Ungültige Anfrage" }, 400);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "Ungültige Anfrage" }, 400);
        if (parsed.agent !== undefined) agent = parsed.agent;
      }
      if (typeof agent !== "string" || !AGENT_NAME_PATTERN.test(agent) || !agentNames.has(agent)) {
        return json({ error: "Ungültiger Agent" }, 400);
      }
      // Mit Forum-Gruppe ein Telegram-Topic (Issue #29, Entscheidung 0005); ohne Gruppe,
      // mit oder ohne Telegram, ein reines Web-Gespräch (Issue #227, Nachtrag zu 0005)
      if (groupChatId()) {
        if (!deps.topics) return json({ error: TOPIC_TEXT.notConfigured }, 503);
        const created = await deps.topics.create(agent);
        return json(created.body, created.status);
      }
      const conversation = await store.createConversation(agent);
      log(`Web-Gespräch angelegt (Agent ${agent})`);
      return json({ conversation }, 201);
    }

    const choiceMatch = CHOICE_PATH.exec(path);
    if (choiceMatch) {
      if (choiceMatch[2] === undefined) return choiceSnapshotRoute(choiceMatch[1], method, new URL(req.url).searchParams.get("ids"));
      return choiceRoute(choiceMatch[1], choiceMatch[2], method, body, auth);
    }
    const match = CONVERSATION_PATH.exec(path);
    if (!match) return null;
    const [, id, action] = match;
    const telegramRef = parseTelegramConversationId(id);
    if (telegramRef) {
      const manages = (!action && (method === "PATCH" || method === "DELETE")) || action === "close" || action === "reopen";
      if (manages) {
        // Direktchat und General: weder umbenennen noch schließen noch löschen (SPEC, Entscheidung 0005)
        if (telegramRef.kind === "dm" || telegramRef.topicId === 1) {
          return action ? json({ error: "Methode nicht erlaubt" }, 405, { Allow: "" }) : methodNotAllowed("GET");
        }
        if (!deps.topics) return json({ error: TOPIC_TEXT.notConfigured }, 503);
      }
      return telegramRoutes(req, id, action, method, body, auth, keepOpen);
    }
    const conversation = isConversationId(id) ? await store.getConversation(id) : null;
    if (!conversation) return json({ error: "Gespräch nicht gefunden" }, 404);

    if (!action) {
      if (method === "PATCH") return renameConversation(id, body);
      if (method === "DELETE") return deleteConversation(id);
      if (method !== "GET") return methodNotAllowed("GET, PATCH, DELETE");
      return json({ conversation, ...hub.status(id) });
    }
    if (action === "messages") {
      if (method === "GET") {
        return json({ messages: await decorateAll(id, (await store.getMessages(id)).map(toApiMessage)), ...hub.status(id) });
      }
      if (method !== "POST") return methodNotAllowed("GET, POST");
      try {
        return await postMessage(hub, conversation, body, auth.source);
      } catch (e) {
        // Inzwischen gelöscht: die Nachricht wurde nicht gespeichert
        if (!(await store.getConversation(id))) return json({ error: "Gespräch nicht gefunden" }, 404);
        throw e;
      }
    }
    if (action === "events") {
      if (method !== "GET") return methodNotAllowed("GET");
      return events(hub, id, req, auth, keepOpen);
    }
    if (action === "reset") return resetConversationSession(hub, id, method);
    // Ältere Web-Gespräche haben keine Ziele (/goal antwortet dort mit einem Hinweis)
    if (action === "goal") {
      if (method === "GET") return json({ card: null });
      if (method !== "POST") return methodNotAllowed("GET, POST");
      return json({ error: GOAL_CARD_TEXT.unavailable, stale: true, card: null }, 409);
    }
    // Schließen und Öffnen gibt es nur für Topics
    if (action === "close" || action === "reopen") return json({ error: "Nicht gefunden" }, 404);
    // action === "stop"
    if (method !== "POST") return methodNotAllowed("POST");
    return json({ stopping: hub.stop(id) });
  }

  /**
   * Web Push (Issue #225): nur für den Browser, nicht für den Terminal-Zugang
   * (der hat weder Service Worker noch Origin-Prüfung). Schreiben braucht wie
   * überall Sitzung und passenden Origin, über den Tunnel den Access-Nachweis.
   */
  async function pushRoutes(req: Request, path: string, method: string, body: string, auth: RequestAuth): Promise<Response> {
    if (auth.source !== "web") return json({ error: "Nur im Browser" }, 403);
    if (path === "/api/push") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!pushApi) return json({ available: false, reason: PUSH_TEXT.notConfigured, devices: [] });
      const result = pushApi.get();
      return json(result.body, result.status);
    }
    if (path === "/api/push/subscriptions") {
      if (method !== "POST") return methodNotAllowed("POST");
      if (!pushApi) return json({ error: PUSH_TEXT.notConfigured }, 503);
      const result = await pushApi.subscribe(body, req.headers.get("user-agent"));
      return json(result.body, result.status);
    }
    if (path === "/api/push/test") {
      if (method !== "POST") return methodNotAllowed("POST");
      if (!pushApi) return json({ error: PUSH_TEXT.notConfigured }, 503);
      const result = await pushApi.test(body);
      return json(result.body, result.status);
    }
    const device = PUSH_DEVICE_PATH.exec(path);
    if (device) {
      if (method !== "PATCH" && method !== "DELETE") return methodNotAllowed("PATCH, DELETE");
      if (!pushApi) return json({ error: PUSH_TEXT.notConfigured }, 503);
      const result = method === "PATCH" ? await pushApi.rename(device[1], body) : await pushApi.remove(device[1]);
      return json(result.body, result.status);
    }
    return json({ error: "Nicht gefunden" }, 404);
  }

  /**
   * POST /api/presence (Issue #226): Anwesenheit eines Tabs, nur aus dem
   * Browser. Anmeldung und Origin prüft route() wie bei jedem Schreiben.
   * Auch eine verspätete Meldung ergibt 204, sie ändert nur nichts.
   */
  function presenceRoute(method: string, body: string, auth: RequestAuth): Response {
    if (auth.source !== "web") return json({ error: "Nur im Browser" }, 403);
    if (method !== "POST") return methodNotAllowed("POST");
    const report = parsePresenceReport(body);
    if (!report) return json({ error: "Ungültige Anfrage" }, 400);
    presence.report(report, { session: auth.session, isAuthorized: () => auth.isAuthorized() });
    return new Response(null, { status: 204 });
  }

  async function route(req: Request, peerIp: string, keepOpen: () => void): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Getunnelt (Issue #98, Tailscale seit #231): nur der öffentliche Host, nur
    // der öffentliche Origin; sonst alles wie im Heimnetz
    const origin = requestOrigin(req, peerIp, config.publicOrigin, remote ?? "cloudflare");
    const publicOrigin = origin.tunneled ? config.publicOrigin! : null;
    const hostOk = publicOrigin
      ? isPublicHost(req.headers.get("host"), publicOrigin)
      : isAllowedHost(req.headers.get("host"), hostCheck);
    if (!hostOk) return text("Misdirected Request", 421);
    // Für Log und Login-Bremse; getunnelte Besucher zählen getrennt von lokalen Adressen
    const who = origin.via === "tailscale" ? `${origin.clientIp} (Tailscale)` : origin.tunneled ? `${origin.clientIp} (Tunnel)` : origin.clientIp;
    const limiterKey = origin.tunneled ? `tunnel:${origin.clientIp}` : origin.clientIp;

    // Access-Nachweis (Issue #99) vor Anmeldung, Body und Routing: gilt für
    // Login, statische Dateien, Downloads, Uploads und Live-Verbindungen.
    // Über Tailscale gibt es kein Access; dort schützen Tailnet und Passwort
    if (origin.tunneled && origin.via === "cloudflare") {
      const access: AccessResult = accessVerifier
        ? await accessVerifier.verify(req.headers.get(ACCESS_JWT_HEADER))
        : { ok: false, reason: "nicht-eingerichtet" };
      logAccess(who, access);
      if (!access.ok) {
        return path === "/api" || path.startsWith("/api/") ? json({ error: ACCESS_DENIED_TEXT }, 403) : text(ACCESS_DENIED_TEXT, 403);
      }
    }

    // Teilen-Ziel (Issue #229): den POST fängt sonst der Service Worker ab.
    // Kommt er doch an (Worker noch nicht aktiv), wird nichts gelesen, nichts
    // gespeichert und ohne Origin- und Login-Prüfung auf die Startseite
    // umgeleitet; hinter dem Tunnel gilt der Access-Nachweis oben trotzdem.
    if (path === SHARE_TARGET_PATH && method === "POST") {
      await discardBody(req);
      return new Response(null, { status: 303, headers: { Location: "/" } });
    }

    const cookieToken = readCookie(req, COOKIE_NAME);
    // Terminal (Issue #59): Schlüssel nur über eine echt lokale Verbindung
    // (Loopback, nicht getunnelt, Entscheidung 0014); die Adresse kommt
    // aus der Verbindung (peerIp), nie aus Kopfzeilen
    const bearer = parseBearer(req.headers.get("authorization"));
    const terminal = cliToken;
    const viaTerminal = bearer?.token != null && origin.local && !!terminal?.matches(bearer.token);
    // Auch fehlerhafte Bearer-Kopfzeilen („Bearer", „Bearer a b") enden hier mit 401, nicht erst an der Origin-Prüfung
    if (bearer !== null && !viaTerminal && !sessions.isValid(cookieToken)) {
      log(`Terminal-Anmeldung abgelehnt von ${who}`);
      return json({ error: "Nicht angemeldet" }, 401);
    }
    // Keine Browser-Anfrage: Origin nur mit gültigem Schlüssel entbehrlich
    const originOk = publicOrigin ? isPublicOrigin(req, publicOrigin) : isSameOrigin(req);
    if (WRITE_METHODS.has(method) && !viaTerminal && !originOk) return json({ error: "Fremder Origin" }, 403);

    // Die Demo-Session ist ein lokales Sonderrecht und gilt nie über den Tunnel
    // oder eine andere Weiterleitung (Tailscale, Issue #231)
    const token = demoToken && origin.local && !sessions.isValid(cookieToken) ? demoToken : cookieToken;
    const loggedIn = viaTerminal || sessions.isValid(token);
    const auth: RequestAuth = viaTerminal
      ? { session: terminal!.sessionId, isAuthorized: () => terminal!.isActive(), source: "terminal", tunneled: false }
      : {
          session: token ? hashToken(token) : "",
          isAuthorized: () => sessions.isValid(token),
          source: "web",
          // Auch weitergeleitet ohne passende öffentliche Adresse (Issue #231)
          tunneled: isRemoteRequest(req, peerIp, origin),
        };

    // Upload (Issue #72): Rohdaten mit eigener Grenze, erst nach Anmeldung und
    // Prüfung des Gesprächs gelesen; alle anderen Grenzen bleiben
    const upload = method === "POST" ? ATTACHMENT_PATH.exec(path) : null;
    if (upload && upload[2] === undefined) {
      if (!loggedIn) {
        await discardBody(req);
        return json({ error: "Nicht angemeldet" }, 401);
      }
      return uploadAttachment(req, upload[1]);
    }

    // Jeden Body vor dem Routing lesen, damit das Limit überall gilt, mit und ohne Content-Length
    const isNewMessage = method === "POST" && /^\/api\/conversations\/[^/]+\/messages$/.test(path);
    let body: string;
    try {
      body = await readLimitedText(req, isNewMessage ? MAX_MESSAGE_BODY_BYTES : MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) return tooLarge();
      throw e;
    }

    if (path === "/api/login") {
      if (method !== "POST") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "POST" });
      if (limiter.isBlocked(limiterKey)) {
        log(`Login gesperrt für ${who} (zu viele Fehlversuche)`);
        return json({ error: "Zu viele Fehlversuche, bitte später erneut versuchen" }, 429, {
          "Retry-After": "900",
        });
      }
      let password: unknown;
      try {
        password = JSON.parse(body)?.password;
      } catch {
        return json({ error: "Ungültige Anfrage" }, 400);
      }
      if (typeof password !== "string") return json({ error: "Ungültige Anfrage" }, 400);
      if (!passwordMatches(password, config.password)) {
        limiter.recordFailure(limiterKey);
        log(`Fehlgeschlagener Login von ${who}`);
        return json({ error: "Falsches Passwort" }, 401);
      }
      const newToken = await sessions.create();
      log(`Login von ${who}`);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(newToken, SESSION_TTL_MS / 1000, origin.tunneled) });
    }

    if (path === BRAND_SCRIPT_PATH && (method === "GET" || method === "HEAD")) return brandScriptResponse();
    if (path === MANIFEST_PATH && (method === "GET" || method === "HEAD")) return manifestResponse();
    const publicAsset = PUBLIC_ASSETS[path];
    if (publicAsset && (method === "GET" || method === "HEAD")) {
      if (path === "/login" && loggedIn) return redirect("/");
      return (await serveFile(publicDir, `/${publicAsset}`, uiVersion)) ?? text("Nicht gefunden", 404);
    }

    if (path === "/api" || path.startsWith("/api/")) {
      if (!loggedIn) return json({ error: "Nicht angemeldet" }, 401);
      if (path === "/api/me") {
        if (method !== "GET") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "GET" });
        return json({ authenticated: true });
      }
      // Oberflächen-Version (Issue #111): nur die Prüfsumme, nach Access-Nachweis und Anmeldung
      if (path === UI_VERSION_PATH) {
        if (method !== "GET") return methodNotAllowed("GET");
        return json({ version: uiVersion || null });
      }
      if (path === "/api/logout") {
        if (method !== "POST") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "POST" });
        // Die Demo-Session bleibt, sonst wäre die Demo nach einem Klick weg
        if (token !== demoToken) {
          await sessions.revoke(token);
          if (token) for (const h of hubs) h.closeSession(hashToken(token));
          if (token) presence.clearSession(hashToken(token));
        }
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0, origin.tunneled) });
      }
      const chatResponse = await conversationRoutes(req, path, method, body, auth, keepOpen);
      if (chatResponse) return chatResponse;
      return json({ error: "Nicht gefunden" }, 404);
    }

    if (method !== "GET" && method !== "HEAD") return text("Methode nicht erlaubt", 405);
    if (!loggedIn) return redirect("/login");
    return (await serveFile(publicDir, path === "/" ? "/index.html" : path, uiVersion)) ?? text("Nicht gefunden", 404);
  }

  function finalize(res: Response, path: string): Response {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    const api = path === "/api" || path.startsWith("/api/");
    res.headers.set("Cache-Control", api || res.status >= 300 ? "no-store" : "no-cache");
    return res;
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Bun soll nie selbst mit 413 antworten (dann ohne Sicherheits-Kopfzeilen);
    // die Grenze von 64 KiB prüft route() beim Lesen des Bodys.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(req, srv) {
      let path = "/";
      try {
        path = new URL(req.url).pathname;
        const peerIp = srv.requestIP(req)?.address ?? "unbekannt";
        // SSE-Verbindungen dürfen länger ruhen als Buns Standard von 10 Sekunden
        const keepOpen = () => srv.timeout(req, 0);
        return finalize(await route(req, peerIp, keepOpen), path);
      } catch (e) {
        // Nur der Fehlername: Meldungen können Inhalte aus Anfragen oder Dateien tragen (Issue #50, Prompts)
        log(`Fehler bei ${req.method} ${path} (${e instanceof Error ? e.name : typeof e})`);
        return finalize(text("Interner Fehler", 500), path);
      }
    },
    error() {
      return finalize(text("Interner Fehler", 500), "/");
    },
  });
  hostCheck.port = server.port!;
  // Nicht abgeschickte Anhänge nach 24 Stunden löschen (Issue #72), erst nach erfolgreichem Start
  deps.uploads?.start();

  // Erst nach erfolgreichem Start: ein zweiter Server, der am belegten Port
  // scheitert, ersetzt den Schlüssel des laufenden nicht
  if (deps.cliTokenFile) {
    try {
      cliToken = await createCliToken(deps.cliTokenFile);
    } catch (e) {
      log(`Terminal-Zugang nicht verfügbar: Schlüsseldatei nicht schreibbar (${errorName(e)})`);
    }
  }

  const displayHost = config.host.includes(":") ? `[${config.host}]` : config.host;
  let stopped = false;
  return {
    url: `http://${displayHost}:${server.port}`,
    eventStreamCount: () => hub.subscriberCount() + telegramHub.subscriberCount(),
    isConversationVisible: id => presence.isVisible(id),
    async postToConversation(conversationId, post) {
      if (stopped || !isConversationId(conversationId) || typeof post.text !== "string" || !post.text.trim()) return false;
      if (!(await store.getConversation(conversationId))) return false;
      const source = post.kind === "notice" && typeof post.source === "string" && NOTICE_SOURCE_PATTERN.test(post.source) ? post.source : undefined;
      const choiceId = isChoiceId(post.choiceId) ? post.choiceId : undefined;
      hub.postAfterTurn(
        conversationId,
        {
          role: "assistant",
          text: post.text,
          ...(post.kind === "notice" ? { kind: "notice" as const, ...(source ? { source } : {}) } : {}),
          ...(choiceId ? { choiceId } : {}),
        },
        // Meldung abgelegt: Push (Issue #226), wenn das Gespräch nirgends sichtbar ist
        post.kind === "notice"
          ? stored => void notifier?.notice({ conversationId, text: stored.text, ...(source ? { source } : {}), ...(choiceId ? { choiceId } : {}) })
          : undefined
      );
      return true;
    },
    async stop(options?: ChatShutdownOptions) {
      stopped = true;
      // Zuerst: ab jetzt gilt der Schlüssel nicht mehr, die Datei verschwindet
      await cliToken?.remove();
      stopLive?.();
      stopLive = null;
      stopWebNotices?.();
      stopWebNotices = null;
      stopGoals?.();
      stopGoals = null;
      stopChoices?.();
      stopChoices = null;
      stopTopicChanges?.();
      stopTopicChanges = null;
      stopEngineChanges?.();
      stopEngineChanges = null;
      stopAutoTitle?.();
      stopAutoTitle = null;
      deps.uploads?.stop();
      await Promise.all(hubs.map(h => h.shutdown(options)));
      await server.stop(true);
    },
  };
}
