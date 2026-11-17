/**
 * Zusätzliche Wege im Server-Profil (Issue #351, Entscheidung E3): Sie hängen
 * am Webhook-Listener von Telegram (src/lib/telegram-runtime.ts), den es nur
 * mit TYBO_PROFILE=server gibt. Auf dem eigenen Rechner (Profil local) ist
 * keiner davon erreichbar; dort bleibt der lokale Health-Server mit /health
 * und /process (src/app/health-server.ts, Entscheidung 0001) unverändert.
 *
 * Wege:
 * - GET /health: Lebenszeichen für Deploy und Überwachung, mit der Revision
 *   (RELEASE_REVISION, ohne Wert "working-tree"). Keine Session, keine PID,
 *   nichts aus Gesprächen: der Listener steht hinter einem öffentlichen Proxy.
 * - POST /deploy (optional, DEPLOY_SECRET): Push-Ereignis von GitHub,
 *   signiert im Kopf X-Hub-Signature-256 (HMAC-SHA256 über den Rohbody).
 *   Nur ein Push auf DEPLOY_BRANCH (Standard refs/heads/master, auch ohne
 *   refs/heads/ angebbar) startet das Deploy-Skript (DEPLOY_SCRIPT, Standard
 *   deploy.sh im Projekt), höchstens eins zur Zeit. 202 erst, wenn der
 *   Prozess läuft; startet er nicht (auch als späteres error-Ereignis), 500.
 * - POST /webhook/elevenlabs (optional, ELEVENLABS_WEBHOOK_SECRET):
 *   Protokoll nach einem Anruf, signiert im Kopf ElevenLabs-Signature
 *   (t=<Sekunden>,v0=<HMAC>, höchstens 5 Minuten alt). Mit agent_id und
 *   Gesprächsbeginn an die Nachlauf-Weiche (Issue #496): Gespräche eines
 *   Rezept-Agenten legt sie beim Rezept ab und wertet sie dort aus, alles
 *   andere geht wie bisher an den Anrufdienst (src/lib/phone/), der es wie ein abgefragtes Protokoll
 *   bearbeitet: Zusammenfassung, Verlauf, Rückfrage zum Auftrag. Anrufe, die
 *   tybo nicht gewählt hat, legt er an und fasst sie im Direktchat zusammen.
 *   Doppelte Zustellung sperrt dessen dauerhafte Anrufliste; scheitert die
 *   Zusammenfassung, antwortet der Weg mit 500 und eine erneute Zustellung
 *   wird bearbeitet.
 *
 * Ohne Secret antwortet ein optionaler Weg mit 503 und tut nichts. Ins Log
 * kommen Weg und Ausgang, nie Inhalte oder Signaturen.
 */
import { spawn } from "child_process";
import { createHmac } from "crypto";
import { join } from "path";
import { secretMatches, verifyElevenLabs } from "../lib/http-security";
import type { TranscriptDelivery, TranscriptLine } from "../lib/phone";
import { linesFromTurns } from "../lib/phone";
import { HEALTH_SERVICE } from "./health-server";

type Env = Record<string, string | undefined>;

export const SERVER_PATHS = { health: "/health", deploy: "/deploy", elevenlabs: "/webhook/elevenlabs" } as const;

/** Revision ohne RELEASE_REVISION (Checkout statt Release) */
export const UNKNOWN_REVISION = "working-tree";
/** Standard-Branch für /deploy */
export const DEFAULT_DEPLOY_BRANCH = "refs/heads/master";
/** Größte Anfrage an /deploy und /webhook/elevenlabs */
export const SERVER_BODY_LIMIT = 512 * 1024;

/** Ein laufendes Deploy */
export interface DeployRun {
  /** Erfüllt sich, sobald der Prozess läuft; scheitert, wenn er nicht startet */
  started: Promise<void>;
  /** Erfüllt sich, wenn das Skript endet (auch nach einem Startfehler) */
  done: Promise<unknown>;
}

export interface ServerRoutesDeps {
  env: Env;
  /** Projektordner; dort liegt deploy.sh */
  root: string;
  /**
   * Nachlauf-Weiche der Sprachagenten (src/lib/voice-agents/aftercall.ts), die
   * fremde Agenten an den Anrufdienst weitergibt; null, solange sie nicht steht
   */
  transcripts(): {
    receiveTranscript(conversationId: string, lines: TranscriptLine[], meta?: { agentId?: string; startedAt?: number }): Promise<TranscriptDelivery>;
  } | null;
  /** Deploy-Skript starten; Standard bash <Skript>, losgelöst */
  startDeploy?(script: string): DeployRun;
  now?(): number;
  log?(line: string): void;
}

/** Antwort für einen der Wege oder null, wenn der Pfad keiner davon ist */
export type ServerRoutes = (request: Request) => Promise<Response> | null;

const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

const wrongMethod = (allow: string) => reply(405, { ok: false, error: "Methode nicht erlaubt" }, { Allow: allow });

/** DEPLOY_BRANCH als vollständige Referenz; "main" und "refs/heads/main" sind dasselbe */
export function deployRef(raw: string | undefined): string {
  const branch = (raw ?? "").trim();
  if (!branch) return DEFAULT_DEPLOY_BRANCH;
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** Rohbody bis zur Grenze; null heißt zu groß */
async function bodyWithin(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > limit ? null : bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function defaultStartDeploy(script: string, root: string): DeployRun {
  const child = spawn("bash", [script], { cwd: root, detached: true, stdio: "ignore" });
  child.unref();
  // Ein Startfehler (etwa fehlender Arbeitsordner) kommt als error-Ereignis, nicht als Ausnahme
  const started = new Promise<void>((resolve, reject) => child.once("spawn", () => resolve()).once("error", reject));
  return { started, done: new Promise(resolve => child.once("exit", resolve).once("error", resolve)) };
}

export function createServerRoutes(deps: ServerRoutesDeps): ServerRoutes {
  const { env } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const startDeploy = deps.startDeploy ?? ((script: string) => defaultStartDeploy(script, deps.root));
  let deploying: Promise<unknown> | null = null;

  function health(request: Request): Response {
    if (request.method !== "GET" && request.method !== "HEAD") return wrongMethod("GET, HEAD");
    return reply(200, {
      status: "ok",
      service: HEALTH_SERVICE,
      profile: "server",
      revision: (env.RELEASE_REVISION ?? "").trim() || UNKNOWN_REVISION,
      timestamp: new Date(now()).toISOString(),
    });
  }

  async function deploy(request: Request): Promise<Response> {
    if (request.method !== "POST") return wrongMethod("POST");
    const secret = (env.DEPLOY_SECRET ?? "").trim();
    if (!secret) return reply(503, { ok: false, error: "Deploy ist nicht eingerichtet" });
    const body = await bodyWithin(request, SERVER_BODY_LIMIT);
    if (!body) return reply(413, { ok: false, error: "Anfrage zu groß" });
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    if (!secretMatches(request.headers.get("x-hub-signature-256"), expected)) {
      log("[server] /deploy: Signatur ungültig");
      return reply(401, { ok: false, error: "Signatur ungültig" });
    }
    const event = request.headers.get("x-github-event") ?? "";
    // GitHub schickt beim Einrichten ein ping; alles außer push löst nichts aus
    if (event !== "push") return reply(200, { ok: true, skipped: event === "ping" ? "ping" : "kein Push-Ereignis" });
    const payload = parseJson(body);
    if (!isRecord(payload) || typeof payload.ref !== "string") return reply(400, { ok: false, error: "Push ohne ref" });
    const branch = deployRef(env.DEPLOY_BRANCH);
    if (payload.ref !== branch) return reply(200, { ok: true, skipped: `nicht ${branch}` });
    if (payload.deleted === true) return reply(200, { ok: true, skipped: "Branch gelöscht" });
    if (deploying) return reply(409, { ok: false, error: "Deploy läuft schon" });
    const script = (env.DEPLOY_SCRIPT ?? "").trim() || join(deps.root, "deploy.sh");
    const notStarted = (error: unknown) => {
      log(`[server] /deploy: Skript nicht gestartet (${error instanceof Error ? error.message : "Fehler"})`);
      return reply(500, { ok: false, error: "Deploy nicht gestartet" });
    };
    let run: DeployRun;
    try {
      run = startDeploy(script);
    } catch (error) {
      return notStarted(error);
    }
    const current = run.done.catch(() => {}).finally(() => {
      if (deploying === current) deploying = null;
    });
    // Schon während des Starts belegt: ein zweiter Push wartet nicht, er bekommt 409
    deploying = current;
    try {
      await run.started;
    } catch (error) {
      if (deploying === current) deploying = null;
      return notStarted(error);
    }
    log(`[server] /deploy: Push auf ${branch}, Deploy gestartet`);
    return reply(202, { ok: true, deploy: "gestartet" });
  }

  async function elevenlabs(request: Request): Promise<Response> {
    if (request.method !== "POST") return wrongMethod("POST");
    const secret = (env.ELEVENLABS_WEBHOOK_SECRET ?? "").trim();
    if (!secret) return reply(503, { ok: false, error: "ElevenLabs-Webhook ist nicht eingerichtet" });
    const body = await bodyWithin(request, SERVER_BODY_LIMIT);
    if (!body) return reply(413, { ok: false, error: "Anfrage zu groß" });
    if (!verifyElevenLabs(new TextDecoder().decode(body), request.headers.get("elevenlabs-signature"), secret, now())) {
      log("[server] /webhook/elevenlabs: Signatur ungültig oder abgelaufen");
      return reply(401, { ok: false, error: "Signatur ungültig" });
    }
    const event = parseJson(body);
    if (!isRecord(event)) return reply(400, { ok: false, error: "kein JSON-Objekt" });
    // Andere Ereignisse (Audio, gescheiterte Anwahl) bearbeitet der Anrufdienst über die Abfrage
    if (event.type !== "post_call_transcription") return reply(200, { ok: true, skipped: "anderes Ereignis" });
    const data = event.data;
    const conversationId = isRecord(data) && typeof data.conversation_id === "string" ? data.conversation_id.trim() : "";
    if (!isRecord(data) || !conversationId || !Array.isArray(data.transcript) || !data.transcript.every(isRecord)) {
      return reply(400, { ok: false, error: "Protokoll unvollständig" });
    }
    const phone = deps.transcripts();
    if (!phone) return reply(503, { ok: false, error: "Anrufdienst nicht bereit" });
    const agentId = typeof data.agent_id === "string" && data.agent_id.trim() ? data.agent_id.trim() : undefined;
    const startSecs = isRecord(data.metadata) ? data.metadata.start_time_unix_secs : undefined;
    const startedAt = typeof startSecs === "number" && Number.isFinite(startSecs) && startSecs > 0 ? startSecs * 1000 : undefined;
    let outcome: TranscriptDelivery;
    try {
      outcome = await phone.receiveTranscript(conversationId, linesFromTurns(data.transcript), { ...(agentId ? { agentId } : {}), ...(startedAt !== undefined ? { startedAt } : {}) });
    } catch (error) {
      // Eintrag bleibt offen: ElevenLabs stellt erneut zu, die Abfrage läuft weiter
      log(`[server] /webhook/elevenlabs: Protokoll nicht übernommen (${error instanceof Error ? error.message : "Fehler"})`);
      return reply(500, { ok: false, error: "Protokoll nicht übernommen" });
    }
    if (outcome === "unknown") log("[server] /webhook/elevenlabs: fremder Anruf ohne Protokoll, ignoriert");
    return reply(200, { ok: true, ...(outcome === "accepted" ? {} : { skipped: outcome === "known" ? "schon bearbeitet" : "unbekannter Anruf" }) });
  }

  return request => {
    const { pathname } = new URL(request.url);
    if (pathname === SERVER_PATHS.health) return Promise.resolve(health(request));
    if (pathname === SERVER_PATHS.deploy) return deploy(request);
    if (pathname === SERVER_PATHS.elevenlabs) return elevenlabs(request);
    return null;
  };
}
