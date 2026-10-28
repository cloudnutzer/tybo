/**
 * Weiterleitung auf dem Server (Issue #353, Profil server mit Hybrid).
 *
 * Eine grammY-Middleware ganz vorn entscheidet je Update, ob es an den
 * eigenen Rechner (POST /relay, src/lib/hybrid/relay-endpoint.ts) geht oder
 * hier bleibt. Weitergeleitet werden Nachrichten und bearbeitete Nachrichten
 * aus freigegebenen Chats und Knöpfe, jeweils nur vom Besitzer
 * (TELEGRAM_USER_ID). Alles andere bleibt auf dem Server, auch Updates
 * fremder Absender: ohne Weiterleitung, Registerabfrage oder Hinweis, die
 * Besitzerprüfung des Telegram-Kanals verwirft sie dort still.
 *
 * Ablauf bei gesundem Rechner:
 * - 202 oder 200 (duplicate): fertig, der Server führt nichts aus.
 * - sichere Ablehnung (400, 401, 403, 413, 429, 503 mit Kopf X-Tybo-Relay)
 *   oder keine Verbindung aufgebaut (abgelehnt, Name unbekannt): der Server
 *   verarbeitet selbst (next()) und hält den Rechner bis zur nächsten
 *   Abfrage für nicht gesund.
 * - unklar (Zeitüberschreitung, Abbruch nach dem Senden, jede andere
 *   Antwort, etwa ein Fehler des Tunnels): genau eine Wiederholung mit
 *   derselben updateId. Nach einem unklaren ersten Versuch beweist keine
 *   Antwort außer 202/200 mehr, dass der Rechner nichts ausgeführt hat; der
 *   Server führt dann nichts aus und schreibt einen Hinweis in den Chat.
 *   Lieber einmal zu wenig als doppelt.
 *
 * Knöpfe des Rückfragen-Registers (ch|<id>|<key>): steht die Frage im
 * Register des Servers, bleibt der Klick hier. Sonst gehört sie dem eigenen
 * Rechner; ist der nicht gesund oder lehnt er ab, bekommt der Klick einen
 * Hinweis und die Frage bleibt offen. Sie fällt nie in den Handler des
 * Servers, der unbekannte Fragen als abgelaufen behandelt.
 *
 * stop() bricht laufende Weiterleitungen ab, ohne sie hier auszuführen.
 * Auch eine Statusabfrage oder Antwort, die erst nach stop() eintrifft,
 * führt nicht mehr zum eigenen Handler: Middleware und Client prüfen den
 * Stopp nach jedem Warten bis zur Entscheidung.
 */
import type { Context, MiddlewareFn } from "grammy";
import type { Update } from "grammy/types";
import { parseChoiceCallbackData } from "../choices";
import { RELAY_HEADER, RELAY_PATH } from "./relay-endpoint";
import type { PeerWatch } from "./peer-health";

/** Frist je Versuch; zwei Versuche passen in die 10 Sekunden des Webhooks nicht ganz, der Turn läuft trotzdem weiter */
export const RELAY_ATTEMPT_MS = 8_000;

export const UNCLEAR_MESSAGE_HINT =
  "Ich weiß nicht sicher, ob dein eigener Rechner diese Nachricht übernommen hat. Kommt keine Antwort, schick sie bitte noch einmal.";
export const UNCLEAR_CALLBACK_HINT = "Unklar, ob dein eigener Rechner den Klick bekommen hat. Passiert nichts, tippe bitte noch einmal.";
export const PEER_CHOICE_AWAY_HINT = "Diese Frage liegt auf deinem eigenen Rechner, der gerade nicht erreichbar ist. Sie bleibt offen.";

/** Ergebnis eines Versuchs */
export type RelayAttempt = "accepted" | "duplicate" | "rejected" | "unreached" | "unclear" | "stopped";
/** Ergebnis der Weiterleitung samt Wiederholung */
export type RelayOutcome = "delivered" | "refused" | "unclear" | "stopped";

/** Fehlercodes, bei denen keine Verbindung zustande kam: nichts ist angekommen */
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "FailedToOpenSocket"]);
/** Antworten des Rechners, die sicher heißen: nicht ausgeführt */
const SAFE_REJECTIONS = new Set([400, 401, 403, 413, 429, 503]);

export interface RelayClientDeps {
  /** Basisadresse des Health-Ports des eigenen Rechners */
  peerUrl: string;
  secret: string;
  fetch?: typeof fetch;
  attemptMs?: number;
}

export interface RelayClient {
  send(updateId: number, update: Update): Promise<RelayOutcome>;
  /** bricht laufende Versuche ab; danach endet jeder Versuch mit stopped */
  stop(): void;
}

export function relayUrl(peerUrl: string): string {
  return new URL(RELAY_PATH, peerUrl.endsWith("/") ? peerUrl : `${peerUrl}/`).toString();
}

export function createRelayClient(deps: RelayClientDeps): RelayClient {
  const doFetch = deps.fetch ?? fetch;
  const url = relayUrl(deps.peerUrl);
  const attemptMs = deps.attemptMs ?? RELAY_ATTEMPT_MS;
  const running = new Set<AbortController>();
  let stopped = false;

  const attempt = async (updateId: number, update: Update): Promise<RelayAttempt> => {
    if (stopped) return "stopped";
    const controller = new AbortController();
    running.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("timeout")), attemptMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ updateId, update }),
        signal: controller.signal,
      });
      // Antwort nach stop() eingetroffen: kein Rückfall auf den Server
      if (stopped) return "stopped";
      const fromPeer = response.headers.get(RELAY_HEADER) === "1";
      if (fromPeer && response.status === 202) return "accepted";
      if (fromPeer && response.status === 200) return "duplicate";
      if (fromPeer && SAFE_REJECTIONS.has(response.status)) return "rejected";
      return "unclear";
    } catch (error) {
      if (stopped) return "stopped";
      const code = (error as { code?: unknown } | null)?.code;
      return typeof code === "string" && NOT_CONNECTED.has(code) ? "unreached" : "unclear";
    } finally {
      clearTimeout(timer);
      running.delete(controller);
    }
  };

  return {
    async send(updateId, update) {
      const first = await attempt(updateId, update);
      if (stopped || first === "stopped") return "stopped";
      if (first === "accepted" || first === "duplicate") return "delivered";
      if (first === "rejected" || first === "unreached") return "refused";
      // Unklar: genau eine Wiederholung mit derselben updateId
      const second = await attempt(updateId, update);
      if (stopped || second === "stopped") return "stopped";
      return second === "accepted" || second === "duplicate" ? "delivered" : "unclear";
    },
    stop() {
      stopped = true;
      for (const controller of running) controller.abort(new Error("stopped"));
      running.clear();
    },
  };
}

/** Was die Middleware mit einem Update anfangen soll */
type Route =
  | { kind: "stay" }
  | { kind: "message"; chatId: string; threadId?: number }
  | { kind: "callback" }
  | { kind: "peer-choice" };

export interface RelayMiddlewareDeps {
  peer: Pick<PeerWatch, "healthy" | "markDown">;
  client: Pick<RelayClient, "send">;
  allowChat(chatId: string): boolean;
  /** Telegram-ID des Besitzers; leer heißt: nichts weiterleiten */
  owner: string;
  /** Steht die Rückfrage im Register dieses Rechners? Wirft bei Lesefehler */
  ownsChoice(id: string): Promise<boolean>;
  /** Hybrid beendet? Gilt bis zur Entscheidung, auch nach jedem Warten; Standard nie */
  stopped?: () => boolean;
  log?: (line: string) => void;
}

export function createRelayMiddleware(deps: RelayMiddlewareDeps): MiddlewareFn<Context> {
  const log = deps.log ?? (line => console.log(line));
  const stopped = deps.stopped ?? (() => false);

  const route = async (update: Update): Promise<Route> => {
    // Wie die Besitzerprüfung in src/channels/telegram/channel.ts, vor allem anderen
    const from = (update.message ?? update.edited_message ?? update.callback_query)?.from;
    if (deps.owner === "" || String(from?.id ?? "") !== deps.owner) return { kind: "stay" };
    const message = update.message ?? update.edited_message;
    if (message) {
      const chatId = String(message.chat.id);
      if (!deps.allowChat(chatId)) return { kind: "stay" };
      return { kind: "message", chatId, ...(message.message_thread_id ? { threadId: message.message_thread_id } : {}) };
    }
    const query = update.callback_query;
    if (!query) return { kind: "stay" };
    const choice = parseChoiceCallbackData(query.data);
    if (!choice) return { kind: "callback" };
    try {
      return (await deps.ownsChoice(choice.id)) ? { kind: "stay" } : { kind: "peer-choice" };
    } catch {
      // Register nicht lesbar: der eigene Handler meldet das dem Klick
      return { kind: "stay" };
    }
  };

  return async (ctx, next) => {
    // Schon beendet: keine Abfrage, keine Weiterleitung, das Update bleibt hier
    if (stopped()) return next();
    const update = ctx.update;
    const where = await route(update);
    if (where.kind === "stay") return next();
    // Ab hier läuft eine Entscheidung: endet der Hybrid währenddessen, passiert nichts mehr
    if (stopped()) return;
    const answerClick = (text: string) => ctx.answerCallbackQuery({ text }).catch(() => {});

    const healthy = await deps.peer.healthy();
    if (stopped()) return;
    if (!healthy) {
      if (where.kind === "peer-choice") return answerClick(PEER_CHOICE_AWAY_HINT);
      return next();
    }

    const outcome = await deps.client.send(update.update_id, update);
    if (outcome === "delivered" || outcome === "stopped" || stopped()) return;
    if (outcome === "refused") {
      deps.peer.markDown();
      log(`[hybrid] Update ${update.update_id}: eigener Rechner lehnt ab, Server übernimmt`);
      if (where.kind === "peer-choice") return answerClick(PEER_CHOICE_AWAY_HINT);
      return next();
    }
    log(`[hybrid] Update ${update.update_id}: Ausgang unklar, Server führt nichts aus`);
    if (where.kind === "message") {
      await ctx.api
        .sendMessage(where.chatId, UNCLEAR_MESSAGE_HINT, where.threadId ? { message_thread_id: where.threadId } : {})
        .catch(error => log(`[hybrid] Hinweis an Chat ${where.chatId} nicht gesendet (${error instanceof Error ? error.message : String(error)})`));
      return;
    }
    return answerClick(UNCLEAR_CALLBACK_HINT);
  };
}
