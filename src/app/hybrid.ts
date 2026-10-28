/**
 * Hybrid-Betrieb (Issue #353, Entscheidung E3): ein Server-Bot reicht
 * Telegram-Updates an den eigenen Rechner weiter, solange der sich gesund
 * meldet. src/bot.ts ruft nur startHybrid auf und registriert stop() beim
 * Beenden; die Teile stehen in src/lib/hybrid/.
 *
 * - Profil server mit HYBRID_PEER_URL, GATEWAY_SECRET und Datenbank: Status
 *   des Rechners lesen, Middleware vor allen Handlern.
 * - Profil peer (gültig nur mit GATEWAY_SECRET und Datenbank, siehe
 *   src/lib/runtime-profile.ts): Herzschlag schreiben, POST /relay am
 *   Health-Port, eigener Kennungsbereich für Rückfragen.
 * - sonst: nichts, keine Timer, keine Wege, kein Netz. Höchstens eine
 *   Logzeile, wenn HYBRID_PEER_URL gesetzt ist, aber nicht greift.
 */
import type { Bot } from "grammy";
import { allowedChat } from "../lib/http-security";
import { isIntakeClosed } from "../lib/execution-context";
import { getChoice, PEER_CHOICE_PREFIX, useChoiceIdPrefix } from "../lib/choices";
import { resolveRuntimeProfile } from "../lib/runtime-profile";
import { getStore, selectBackend } from "../lib/store";
import { botGroupId } from "../web/bot-telegram";
import { nodeIdFrom, startPeerBeat, watchPeer, type HeartbeatStore, type Timers } from "../lib/hybrid/peer-health";
import { createRelayEndpoint } from "../lib/hybrid/relay-endpoint";
import { createRelayClient, createRelayMiddleware } from "../lib/hybrid/relay";
import type { TelegramRuntime } from "../lib/telegram-runtime";

type Env = Record<string, string | undefined>;

export interface HybridDeps {
  env: Env;
  runtime: Pick<TelegramRuntime, "relayIntake"> & { readonly bot: Pick<Bot, "use"> | null };
  isShuttingDown(): boolean;
  /** Neustart angefordert (closeIntake); Standard aus src/lib/execution-context.ts */
  isIntakeClosed?: () => boolean;
  /** Herzschlag-Ablage; Standard der TaskStore der Datenbank */
  store?: () => HeartbeatStore;
  allowChat?: (chatId: string) => boolean;
  ownsChoice?: (id: string) => Promise<boolean>;
  fetch?: typeof fetch;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Hybrid {
  /** Rolle dieses Prozesses; off ohne Hybrid */
  readonly role: "server" | "peer" | "off";
  /** POST /relay für den Health-Server; null außer im Profil peer */
  readonly relayRoute: ((request: Request) => Promise<Response>) | null;
  stop(): void;
}

const OFF: Hybrid = { role: "off", relayRoute: null, stop() {} };

function peerUrlFrom(raw: string | undefined): string | null | undefined {
  const text = (raw ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? text : undefined;
  } catch {
    return undefined;
  }
}

export function startHybrid(deps: HybridDeps): Hybrid {
  const env = deps.env;
  const log = deps.log ?? (line => console.log(line));
  const store = deps.store ?? (() => getStore().tasks);
  // Direktchat, freigegebene Chats und die Gruppe des Bots
  const allowChat = deps.allowChat ?? ((chatId: string) => allowedChat(chatId) || chatId === botGroupId(env));
  const profile = resolveRuntimeProfile(env);
  const name = profile.ok ? profile.profile.name : profile.name;
  const peerUrl = peerUrlFrom(env.HYBRID_PEER_URL);

  if (name === "peer") {
    // Auch ohne gültigen Eingang: Kennungen von Rückfragen nie im Bereich des Servers
    useChoiceIdPrefix(PEER_CHOICE_PREFIX);
    if (!profile.ok) return OFF;
    const nodeId = nodeIdFrom(env.HYBRID_NODE_ID);
    const beat = startPeerBeat({ store, nodeId, timers: deps.timers, log });
    const intakeClosed = deps.isIntakeClosed ?? isIntakeClosed;
    let stopped = false;
    const relayRoute = createRelayEndpoint({
      secret: () => (env.GATEWAY_SECRET ?? "").trim(),
      allowChat,
      closing: () => stopped || deps.isShuttingDown() || intakeClosed(),
      intake: () => deps.runtime.relayIntake(),
      log,
    });
    log(`[hybrid] Profil peer: Herzschlag als ${nodeId}, Updates vom Server über /relay am Health-Port`);
    return {
      role: "peer",
      relayRoute,
      stop() {
        stopped = true;
        beat.stop();
      },
    };
  }

  if (peerUrl === null) return OFF;
  if (name !== "server" || !profile.ok) {
    log(`[hybrid] Hybrid aus: HYBRID_PEER_URL gilt nur im Profil server`);
    return OFF;
  }
  const secret = (env.GATEWAY_SECRET ?? "").trim();
  const reason =
    peerUrl === undefined ? "HYBRID_PEER_URL ist keine http- oder https-Adresse"
    : !secret ? "GATEWAY_SECRET fehlt"
    : selectBackend(env) !== "supabase" ? "keine Datenbank (Supabase) eingerichtet"
    : !deps.runtime.bot ? "Telegram ist nicht eingerichtet"
    : null;
  if (reason) {
    log(`[hybrid] Hybrid aus: ${reason}`);
    return OFF;
  }

  // Gemeinsamer Stopp für Middleware, Abfrage und Client
  let stopped = false;
  const peer = watchPeer({ store, nodeId: nodeIdFrom(env.HYBRID_PEER_NODE_ID), now: deps.now });
  const client = createRelayClient({ peerUrl: peerUrl!, secret, fetch: deps.fetch });
  deps.runtime.bot!.use(
    createRelayMiddleware({
      peer,
      client,
      allowChat,
      owner: (env.TELEGRAM_USER_ID ?? "").trim(),
      ownsChoice: deps.ownsChoice ?? (async id => (await getChoice(id)) !== undefined),
      stopped: () => stopped,
      log,
    }),
  );
  log(`[hybrid] Profil server: leite an ${new URL(peerUrl!).origin} weiter, solange der eigene Rechner gesund ist`);
  return {
    role: "server",
    relayRoute: null,
    stop() {
      stopped = true;
      peer.stop();
      client.stop();
    },
  };
}
