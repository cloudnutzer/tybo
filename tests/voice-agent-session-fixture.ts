/**
 * Attrappen für das Web-Gespräch je Rezept (Issue #494): Rezepte und Zustand in
 * einem eigenen Ordner, Anbieter als Fetch-Attrappe, Uhr zum Stellen. Kein Test
 * ruft den Anbieter wirklich auf.
 *
 * Die Attrappe kennt zwei Wege wie ElevenLabs: Token
 * (GET /v1/convai/conversation/token, Antworten aus replies) und Status eines
 * Gesprächs (GET /v1/convai/conversations/<id>, Antwort aus conversation(id)).
 * Ohne eigene conversation-Funktion ist jedes ausgegebene Gespräch in-progress,
 * bis der Test es mit hangUp(id) beim Anbieter beendet; dann done mit der
 * Dauer von der Tokenausgabe bis dahin. Unbekannte IDs: 404. Tests mit Räumen
 * setzen conversation selbst.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebServer } from "../src/web/server";
import { createVoiceAgentSessions, type VoiceAgentSessionOptions } from "../src/web/bot-voice-agent-session";
import { recipeHash } from "../src/lib/voice-agents/base";
import { loadRecipe } from "../src/lib/voice-agents/recipe";
import { updateState } from "../src/lib/voice-agents/state";
import { writeUnlock } from "../src/lib/voice-agents/unlock";
import { writeRecipe } from "./voice-agents-manage-fixture";
import { topicServer, type ServerCtx } from "./topic-fixture";

export const API_KEY = "sk-test-GEHEIMER-ANBIETER-SCHLUESSEL-4711";
export const BRIDGE_TOKEN = "brueckentoken-test-0815-lang-genug";
/** Mitte eines Monats, damit die Zeitzone des Rechners den Monat nicht ändert */
export const START = Date.parse("2026-11-15T12:00:00Z");

/** Laufzeit, die ElevenLabs in seine Gesprächs-Tokens schreibt (exp, gemessen) */
export const PROVIDER_TOKEN_SEC = 900;

/**
 * Gesprächs-Token wie bei ElevenLabs: JWT mit exp in Sekunden. Die Signatur
 * trägt den Namen (etwa gespraechstoken-1), damit Tests das Token erkennen.
 * payload ersetzt den Inhalt ganz (für unlesbare oder fehlende Abläufe).
 */
export function providerToken(name: string, exp: number, payload: unknown = { exp }): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.${name}`;
}

/** Name eines Tokens aus providerToken */
export const tokenName = (token: string) => token.split(".").at(-1);

/** warte: Der Anbieter antwortet erst, wenn das Versprechen erfüllt ist, dann mit einem frischen Token */
export type ProviderReply = { status: number; body: unknown } | "wirft" | "zeitablauf" | { warte: Promise<unknown> };

/** Gespräch beim Anbieter: Status mit Dauer in Sekunden, unbekannt (404), Fehler oder eigene Antwort */
export type ProviderConversation =
  | { status: "initiated" | "in-progress" | "processing" | "done" | "failed"; dauerSek?: number }
  | "unbekannt"
  | "wirft"
  | { http: number; body?: unknown };

/** Standard: ausgegeben heißt in-progress, nach hangUp done mit der Dauer seit der Tokenausgabe */
export function byHangUp(world: Pick<SessionWorld, "issued" | "hungUp">, id: string): ProviderConversation {
  const issued = world.issued.get(id);
  if (issued === undefined) return "unbekannt";
  const ended = world.hungUp.get(id);
  return ended === undefined ? { status: "in-progress" } : { status: "done", dauerSek: Math.round((ended - issued) / 1000) };
}

export interface SessionWorld {
  root: string;
  paths: { configDir: string; dataDir: string };
  env: Record<string, string | undefined>;
  clock: { now: number };
  /** Tokenabrufe beim Anbieter */
  calls: { url: string; headers: Record<string, string> }[];
  /** Antwort des Anbieters je Tokenabruf; ohne Eintrag ein frisches Token */
  replies: ProviderReply[];
  /** Statusabfragen beim Anbieter (Gesprächs-IDs) */
  statusCalls: { id: string; headers: Record<string, string> }[];
  /** Zeitpunkt der Tokenausgabe je Gesprächs-ID */
  issued: Map<string, number>;
  /** Beim Anbieter beendet (Zeitpunkt) je Gesprächs-ID */
  hungUp: Map<string, number>;
  /** Beendet das Gespräch beim Anbieter jetzt (für den Standard byHangUp) */
  hangUp(id: string): void;
  /** Status je Gesprächs-ID; Standard byHangUp */
  conversation: (id: string) => ProviderConversation;
  logs: string[];
  /** Jede Antwort des Anbieters (Token und Status) kommt erst nach so vielen Millisekunden, echt gewartet */
  providerDelayMs: number;
  /** Neuer Port über derselben Ablage, wie nach einem Neustart */
  port(extra?: Partial<VoiceAgentSessionOptions>): ReturnType<typeof createVoiceAgentSessions>;
}

const roots: string[] = [];

export function removeSessionWorlds(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function sessionWorld(options: { env?: Record<string, string | undefined> } = {}): SessionWorld {
  const root = mkdtempSync(join(tmpdir(), "sa-web-"));
  roots.push(root);
  const paths = { configDir: join(root, "config", "voice-agents"), dataDir: join(root, "data", "voice-agents") };
  const env: Record<string, string | undefined> = { ELEVENLABS_API_KEY: API_KEY, VOICE_BRIDGE_TOKEN: BRIDGE_TOKEN, ...options.env };
  const clock = { now: START };
  const calls: SessionWorld["calls"] = [];
  const replies: ProviderReply[] = [];
  const statusCalls: SessionWorld["statusCalls"] = [];
  const issued = new Map<string, number>();
  const hungUp = new Map<string, number>();
  const logs: string[] = [];
  let counter = 0;
  const STATUS = "https://api.elevenlabs.io/v1/convai/conversations/";
  const fetchFake = async (url: string, init: RequestInit) => {
    if (world.providerDelayMs > 0) await Bun.sleep(world.providerDelayMs);
    if (url.startsWith(STATUS)) {
      const id = decodeURIComponent(url.slice(STATUS.length));
      statusCalls.push({ id, headers: { ...(init.headers as Record<string, string>) } });
      const state = world.conversation(id);
      if (state === "wirft") throw new TypeError(`fetch failed ${url} ${API_KEY}`);
      if (state === "unbekannt") return Response.json({ detail: { status: "document_not_found", message: `${API_KEY}` } }, { status: 404 });
      if ("http" in state) return Response.json(state.body ?? { detail: API_KEY }, { status: state.http });
      return Response.json({
        agent_id: "agent_x",
        conversation_id: id,
        status: state.status,
        metadata: { start_time_unix_secs: Math.floor((issued.get(id) ?? clock.now) / 1000), call_duration_secs: state.dauerSek ?? 0 },
        transcript: [{ role: "user", message: `Geheimer Inhalt ${API_KEY}` }],
      });
    }
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    let reply = replies.shift();
    if (reply && typeof reply === "object" && "warte" in reply) {
      await reply.warte;
      reply = undefined;
    }
    if (reply === "wirft") throw new TypeError(`fetch failed ${url} ${API_KEY}`);
    if (reply === "zeitablauf") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    counter++;
    issued.set(`conv_${counter}`, clock.now);
    return Response.json({ token: providerToken(`gespraechstoken-${counter}`, Math.floor(clock.now / 1000) + PROVIDER_TOKEN_SEC), conversation_id: `conv_${counter}` });
  };
  const world: SessionWorld = {
    root,
    paths,
    env,
    clock,
    calls,
    replies,
    statusCalls,
    issued,
    hungUp,
    hangUp: (id) => void hungUp.set(id, clock.now),
    conversation: (id) => byHangUp(world, id),
    logs,
    providerDelayMs: 0,
    port: (extra = {}) =>
      createVoiceAgentSessions({
        paths,
        env,
        fetch: fetchFake,
        now: () => clock.now,
        log: (line) => void logs.push(line),
        // Nachfragen nach dem Auflegen ohne echtes Warten
        sleep: async () => {},
        ...extra,
      }),
  };
  return world;
}

/**
 * Rezept anlegen wie nach Abgleich und Freischaltung: state.json mit dem Hash
 * der Fassung, freischaltung.json mit demselben Hash.
 */
export async function readyAgent(world: Pick<SessionWorld, "paths">, kennung: string, change: (raw: any) => void = () => {}): Promise<string> {
  writeRecipe(world, kennung, change);
  const recipe = (await loadRecipe(kennung, world.paths))!;
  const hash = recipeHash(recipe);
  await updateState(kennung, { kennung, anbieter: "elevenlabs", agentId: `agent_${kennung.replace(/-/g, "_")}`, letzterHash: hash } as any, world.paths);
  const unlocked = await writeUnlock(kennung, { hash, version: 1, wissenHash: null, grund: "tests" }, world.paths);
  if (unlocked.status !== "freigeschaltet") throw new Error(`nicht freigeschaltet: ${unlocked.status}`);
  return hash;
}

export const bridge = (raw: any) => {
  raw.gehirn = { art: "bruecke", modell: "claude-opus-5-5" };
};

export async function sessionServer(root: string, servers: WebServer[], world: SessionWorld): Promise<ServerCtx> {
  return topicServer(root, servers, null, { voiceAgentSessions: world.port() });
}
