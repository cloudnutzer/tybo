/**
 * Web-Gespräch je Rezept (Issue #494, Entscheidung 0026): Die WebUI holt hinter
 * dem Login ein kurzlebiges Gesprächs-Token beim Anbieter und gibt nur dieses
 * an den Browser weiter, nie den Schlüssel.
 *
 * Routen (server.ts):
 * - GET  /api/voice-agents/<kennung>             Zustand für die Gesprächsseite
 * - POST /api/voice-agents/<kennung>/session     Token und Gesprächs-ID
 * - POST /api/voice-agents/<kennung>/session/end Ende melden ({ conversationId })
 * - GET  /sa/<kennung>                           Gesprächsseite
 *
 * Reihenfolge beim Start: Rezept bekannt, Web-Zugang an, freigeschaltet
 * (unlock.ts), beim Anbieter in genau dieser Fassung abgeglichen (state.json),
 * Anbieter eingerichtet; dann unter der Sperre der Kennung Parallelität,
 * Rate-Limit und Minutenbudget prüfen und reservieren (web-sessions.ts), erst
 * danach das Token holen. Der Abruf läuft ohne Sperre. Danach, wieder unter
 * der Sperre, muss die Reservierung noch offen sein (noch nicht abgelaufen)
 * und der Stand derselbe: Rezept, Wissensdatei, Web-Zugang, Freischaltung,
 * Abgleich und Agent beim Anbieter. Sonst gibt es weder Token noch Freigabe.
 * Bei gehirn.art bruecke steht die Web-Freigabe für die Gesprächs-ID
 * (web-calls.ts) fest, bevor die Antwort rausgeht, und gilt so lange wie die
 * Reservierung; bei anbieter gibt es keine Freigabe und VOICE_BRIDGE_TOKEN ist
 * nicht nötig.
 *
 * Wahrheit beim Anbieter (web-sessions.ts): Ob ein Gespräch noch läuft, weiß
 * nur ElevenLabs. Der Browser kann eine Trennung nie sicher belegen (ein
 * gescheiterter oder hängender SDK-Aufbau kann einen Raum offen halten). Seine
 * Endemeldung (/session/end) ist deshalb nur ein Anlass: Der Server fragt
 * GET /v1/convai/conversations/<id>
 * (https://elevenlabs.io/docs/api-reference/conversations/get, Feld status:
 * initiated, in-progress, processing, done, failed; metadata.call_duration_secs;
 * unbekannte ID 404) und gibt Platz, Freigabe und Minuten erst frei, wenn der
 * Anbieter das Ende belegt (settle). Dasselbe fragt er vor jedem Start und für
 * die Zustandsroute zu jedem offenen Gespräch, sodass ein vergessenes Ende sich
 * von selbst klärt. Ohne Nachweis (aktiv, nicht erreichbar, unklar, unbekannt
 * vor Tokenablauf) bleibt alles belegt, längstens bis zur harten Grenze
 * Tokenablauf plus maxMinuten plus Zuschlag.
 *
 * Browser-Verbindung: WebRTC mit dem Token aus GET
 * /v1/convai/conversation/token (Antwort token und conversation_id,
 * https://elevenlabs.io/docs/api-reference/conversations/get-webrtc-token),
 * auf der Gesprächsseite über das selbst gehostete SDK
 * (src/web/public/sprachagent.js, public/vendor/elevenlabs/). Auflegen meldet
 * die Seite nach dem Trennen über /session/end mit genau ihrer Gesprächs-ID.
 * Ohne diese ID gibt es kein Ende. Bestätigt der Anbieter das Ende, wird erst
 * die Freigabe gelöscht, dann das Ende gespeichert: Scheitert das Löschen,
 * bleibt das Gespräch offen, und ein zweites Auflegen versucht es noch einmal.
 * Bestätigt er es (noch) nicht, antwortet /session/end mit 202 ausstehend.
 *
 * Tokenablauf: Freigabe, harte Grenze und expiresInSec folgen dem exp des
 * ausgegebenen Tokens (ElevenLabs: 900 Sekunden). Ein Token ohne lesbaren
 * Ablauf oder mit mehr als WEB_SESSION_TOKEN_MAX_MS bekommt der Browser nicht
 * (502 token_ablauf), die Reservierung wird zurückgenommen.
 *
 * HTTP-Zeitlimit: Start (Statusklärung plus Tokenabruf), Zustand
 * (Statusklärung) und Ende (bis zu drei Statusabrufe plus Wartezeiten) können
 * länger dauern als Buns Ruhezeit von 10 Sekunden; server.ts hält diese
 * Verbindungen deshalb offen (keepOpen). Jeder Abruf ist durch timeoutMs
 * begrenzt, die Routen enden also immer.
 *
 * Ins Log kommen Kennung, Ausgang und ein kurzer Hash der Gesprächs-ID, nie
 * Token, Schlüssel oder Text des Anbieters.
 */
import { createHash, randomUUID } from "node:crypto";
import { ELEVENLABS_API } from "../lib/speech/elevenlabs";
import { isValidKennung, recipeHash, recipePath, recipesDir, readRegularFile, realDirsExist, type VoiceAgentPaths } from "../lib/voice-agents/base";
import { parseLayerState } from "../lib/voice-agents/layer";
import { loadRecipe, type Recipe } from "../lib/voice-agents/recipe";
import { readState, withAgentLock } from "../lib/voice-agents/state";
import { isUnlocked, knowledgeHash } from "../lib/voice-agents/unlock";
import { isValidConversationId, issueWebCall, revokeWebCall } from "../lib/voice-agents/web-calls";
import {
  attach,
  isRunning,
  prune,
  readWebSessions,
  release,
  reserve,
  runningSession,
  settle,
  tokenExpiry,
  usedMinutes,
  writeWebSessions,
  type ProviderState,
  type WebSessionFile,
} from "../lib/voice-agents/web-sessions";
import {
  VOICE_AGENT_PROVIDER_TIMEOUT_MS,
  VOICE_AGENT_SESSION_TEXT,
  type VoiceAgentPageOutcome,
  type VoiceAgentSessionPort,
  type VoiceAgentSessionResult,
} from "./voice-agent-page";

const MAX_TOKEN_CHARS = 8_192;
const PROVIDER = "elevenlabs";
const TEXT = VOICE_AGENT_SESSION_TEXT;

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface VoiceAgentSessionOptions {
  paths?: VoiceAgentPaths;
  /** Wird bei jedem Aufruf gelesen, damit ein neuer Schlüssel ohne Neustart gilt */
  env?: Env;
  fetch?: Fetch;
  now?: () => number;
  log?: (line: string) => void;
  timeoutMs?: number;
  /**
   * Wartezeiten vor den Nachfragen beim Anbieter nach einer Endemeldung: Der
   * Status wechselt kurz nach dem Auflegen von in-progress auf processing.
   */
  endCheckDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Standard für endCheckDelaysMs: sofort, dann nach 1,5 und 3 Sekunden */
export const VOICE_AGENT_END_CHECK_DELAYS_MS = [0, 1_500, 3_000] as const;

/** Stand, für den ein Token ausgegeben wird: Agent beim Anbieter, Rezeptfassung, Wissensinhalt */
interface Stand {
  agentId: string;
  hash: string;
  wissenHash: string | null;
}

const sameStand = (a: Stand, b: Stand) => a.agentId === b.agentId && a.hash === b.hash && a.wissenHash === b.wissenHash;

type Blocker = "unbekannt" | "kaputt" | "kein_web" | "gesperrt" | "nicht_abgeglichen" | "kein_anbieter" | "keine_bruecke";

const BLOCKER_RESULT: Record<Blocker, { status: number; error: string }> = {
  unbekannt: { status: 404, error: TEXT.unknown },
  kaputt: { status: 409, error: TEXT.broken },
  kein_web: { status: 403, error: TEXT.noWeb },
  gesperrt: { status: 403, error: TEXT.locked },
  nicht_abgeglichen: { status: 409, error: TEXT.notSynced },
  kein_anbieter: { status: 503, error: TEXT.noProvider },
  keine_bruecke: { status: 503, error: TEXT.noBridge },
};

const fail = (status: number, error: string, reason: string, headers?: Record<string, string>): VoiceAgentSessionResult => ({
  status,
  body: { error, reason },
  ...(headers ? { headers } : {}),
});

const blocked = (blocker: Blocker) => fail(BLOCKER_RESULT[blocker].status, BLOCKER_RESULT[blocker].error, blocker);

/** Kurzer, nicht umkehrbarer Hinweis auf die Gesprächs-ID fürs Log */
function shortId(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 8);
}

export function createVoiceAgentSessions(options: VoiceAgentSessionOptions = {}): VoiceAgentSessionPort {
  const paths = options.paths ?? {};
  const env = options.env ?? process.env;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.log(line));
  const timeoutMs = options.timeoutMs ?? VOICE_AGENT_PROVIDER_TIMEOUT_MS;
  const endCheckDelays = options.endCheckDelaysMs ?? VOICE_AGENT_END_CHECK_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const value = (name: string) => env[name]?.trim() ?? "";

  /** Rezeptdatei vorhanden? Ungültige Kennungen gibt es nie, und für sie entsteht kein Ordner. */
  async function recipeExists(kennung: string): Promise<boolean> {
    if (!isValidKennung(kennung)) return false;
    if (!(await realDirsExist([recipesDir(paths)]))) return false;
    return (await readRegularFile(recipePath(kennung, paths))) !== null;
  }

  async function loadChecked(kennung: string): Promise<{ recipe: Recipe } | { blocker: Blocker }> {
    if (!(await recipeExists(kennung))) return { blocker: "unbekannt" };
    let recipe: Recipe | null;
    try {
      recipe = await loadRecipe(kennung, paths);
    } catch {
      return { blocker: "kaputt" };
    }
    if (!recipe) return { blocker: "unbekannt" };
    return { recipe };
  }

  /** Alles außer Reservierung: Web-Zugang, Freischaltung, Abgleich, Einrichtung. */
  async function blockerFor(recipe: Recipe): Promise<{ blocker: Blocker } | { stand: Stand }> {
    if (recipe.zugang.web?.link !== true) return { blocker: "kein_web" };
    if (!(await isUnlocked(recipe.kennung, paths))) return { blocker: "gesperrt" };
    let wissenHash: string | null;
    try {
      wissenHash = await knowledgeHash(recipe, paths);
    } catch {
      return { blocker: "gesperrt" };
    }
    let agentId: string | undefined;
    try {
      const raw = await readState(recipe.kennung, paths);
      const state = raw ? parseLayerState(raw) : null;
      // Nur die abgeglichene Fassung: gleicher Hash, nichts ausstehend
      if (state && state.anbieter === PROVIDER && state.letzterHash === recipeHash(recipe) && !state.ausstehend) agentId = state.agentId;
    } catch {
      agentId = undefined;
    }
    if (!agentId) return { blocker: "nicht_abgeglichen" };
    if (!value("ELEVENLABS_API_KEY")) return { blocker: "kein_anbieter" };
    if (recipe.gehirn.art === "bruecke" && !value("VOICE_BRIDGE_TOKEN")) return { blocker: "keine_bruecke" };
    return { stand: { agentId, hash: recipeHash(recipe), wissenHash } };
  }

  async function page(kennung: string): Promise<VoiceAgentPageOutcome> {
    const loaded = await loadChecked(kennung);
    if ("blocker" in loaded) return loaded.blocker === "unbekannt" ? "unbekannt" : "ok";
    return loaded.recipe.zugang.web?.link === true ? "ok" : "kein_web";
  }

  async function info(kennung: string): Promise<VoiceAgentSessionResult> {
    const loaded = await loadChecked(kennung);
    if ("blocker" in loaded) return blocked(loaded.blocker);
    const { recipe } = loaded;
    if (recipe.zugang.web?.link !== true) return blocked("kein_web");
    const check = await blockerFor(recipe);
    await reconcile(kennung);
    let data: WebSessionFile | null = null;
    try {
      data = prune(await readWebSessions(kennung, paths), now());
    } catch {
      data = null;
    }
    const at = now();
    const running = data ? runningSession(data, at) : null;
    const body: Record<string, unknown> = {
      kennung,
      name: recipe.name,
      gehirn: recipe.gehirn.art,
      maxMinuten: recipe.zugang.maxMinuten,
      minuten: { verbraucht: data ? usedMinutes(data, at) : null, limit: recipe.zugang.budget.minutenMonat },
      laufend: running ? { seit: new Date(running.start).toISOString(), bis: new Date(running.bis).toISOString() } : null,
      bereit: !("blocker" in check) && data !== null,
    };
    if ("blocker" in check) Object.assign(body, { reason: check.blocker, grund: BLOCKER_RESULT[check.blocker].error });
    else if (!data) Object.assign(body, { reason: "ablage", grund: TEXT.storage });
    return { status: 200, body };
  }

  type Reserved = { stand: Stand; id: string } | VoiceAgentSessionResult;

  /** Unter der Sperre der Kennung: dieselbe Sperre wie Speichern und Abgleich, also ein fester Stand. */
  function reserveSlot(kennung: string): Promise<Reserved> {
    return withAgentLock(kennung, paths, async (): Promise<Reserved> => {
      const loaded = await loadChecked(kennung);
      if ("blocker" in loaded) return blocked(loaded.blocker);
      const check = await blockerFor(loaded.recipe);
      if ("blocker" in check) return blocked(check.blocker);
      let data: WebSessionFile;
      try {
        data = await readWebSessions(kennung, paths);
      } catch (e) {
        log(`[sprachagent] ${kennung} Web-Gespräch: Ablage nicht lesbar (${e instanceof Error ? e.name : "Fehler"})`);
        return fail(503, TEXT.storage, "ablage");
      }
      const id = randomUUID();
      const { zugang } = loaded.recipe;
      const outcome = reserve(data, { now: now(), id, maxMinuten: zugang.maxMinuten, minutenMonat: zugang.budget.minutenMonat });
      switch (outcome.status) {
        case "laeuft":
          return { status: 409, body: { error: TEXT.running, reason: "laeuft", bis: new Date(outcome.bis).toISOString() } };
        case "zu_viele":
          return fail(429, TEXT.tooMany, "zu_viele", { "Retry-After": String(outcome.retryAfterSec) });
        case "budget":
          return fail(429, TEXT.budget, "budget", { "Retry-After": String(outcome.retryAfterSec) });
      }
      await writeWebSessions(kennung, outcome.data, paths);
      return { stand: check.stand, id };
    });
  }

  async function update(kennung: string, change: (data: WebSessionFile) => WebSessionFile): Promise<void> {
    await withAgentLock(kennung, paths, async () => writeWebSessions(kennung, change(await readWebSessions(kennung, paths)), paths));
  }

  /** Token beim Anbieter; null bei jedem Fehler. Geloggt wird nur der Status, nie der Text der Antwort. */
  async function fetchToken(kennung: string, agentId: string): Promise<{ token: string; conversationId: string } | null> {
    let response: Response;
    try {
      response = await doFetch(`${ELEVENLABS_API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, {
        method: "GET",
        headers: { "xi-api-key": value("ELEVENLABS_API_KEY") },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      log(`[sprachagent] ${kennung} Web-Gespräch: Anbieter ${name === "TimeoutError" || name === "AbortError" ? "Zeitablauf" : "nicht erreichbar"}`);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      log(`[sprachagent] ${kennung} Web-Gespräch: Anbieter antwortet mit HTTP ${response.status}`);
      return null;
    }
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    const token = data?.token;
    const conversationId = data?.conversation_id;
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS || !isValidConversationId(conversationId)) {
      log(`[sprachagent] ${kennung} Web-Gespräch: Antwort des Anbieters unvollständig`);
      return null;
    }
    return { token, conversationId };
  }

  /**
   * Status eines Gesprächs beim Anbieter. Nur lesend; geloggt wird nur der
   * Ausgang, nie der Text der Antwort.
   */
  async function conversationState(kennung: string, conversationId: string): Promise<ProviderState> {
    if (!value("ELEVENLABS_API_KEY")) return { status: "unklar" };
    let response: Response;
    try {
      response = await doFetch(`${ELEVENLABS_API}/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
        method: "GET",
        headers: { "xi-api-key": value("ELEVENLABS_API_KEY") },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      log(`[sprachagent] ${kennung} Web-Gespräch: Status beim Anbieter ${name === "TimeoutError" || name === "AbortError" ? "Zeitablauf" : "nicht erreichbar"} (${shortId(conversationId)})`);
      return { status: "unklar" };
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return { status: "unbekannt" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      log(`[sprachagent] ${kennung} Web-Gespräch: Status beim Anbieter HTTP ${response.status} (${shortId(conversationId)})`);
      return { status: "unklar" };
    }
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    // Nur eine Antwort zu genau diesem Gespräch zählt
    if (data?.conversation_id !== undefined && data.conversation_id !== conversationId) return { status: "unklar" };
    switch (data?.status) {
      case "initiated":
      case "in-progress":
        return { status: "aktiv" };
      case "processing":
      case "done":
      case "failed": {
        const dauer = data?.metadata?.call_duration_secs;
        return { status: "beendet", dauerSek: Number.isFinite(dauer) && dauer >= 0 ? dauer : null };
      }
    }
    log(`[sprachagent] ${kennung} Web-Gespräch: Status beim Anbieter nicht lesbar (${shortId(conversationId)})`);
    return { status: "unklar" };
  }

  type Settled = { status: "beendet"; minuten: number } | { status: "offen"; provider: ProviderState } | { status: "kein_gespraech" };

  /**
   * Übernimmt den Befund des Anbieters unter der Sperre der Kennung. Beendet:
   * erst die Freigabe löschen, dann das Ende speichern; scheitert das Löschen,
   * wirft es mit revokeFailed und das Gespräch bleibt offen.
   */
  function applyProvider(kennung: string, conversationId: string, provider: ProviderState): Promise<Settled> {
    return withAgentLock(kennung, paths, async (): Promise<Settled> => {
      const outcome = settle(await readWebSessions(kennung, paths), now(), conversationId, provider);
      if (outcome.status === "kein_gespraech") return outcome;
      if (outcome.status === "offen") return { status: "offen", provider };
      try {
        // Ohne Freigabe (gehirn anbieter) ist nichts zu löschen
        await revokeWebCall({ kennung, conversationId }, paths);
      } catch (e) {
        throw Object.assign(new Error("Freigabe nicht gelöscht", { cause: e }), { revokeFailed: true });
      }
      await writeWebSessions(kennung, outcome.data, paths);
      log(`[sprachagent] ${kennung} Web-Gespräch: beendet laut Anbieter (${shortId(conversationId)}, ${outcome.session.minuten} min)`);
      return { status: "beendet", minuten: outcome.session.minuten };
    });
  }

  /**
   * Fragt für jedes offene Gespräch mit Gesprächs-ID beim Anbieter nach und
   * beendet, was er belegt. Der Abruf läuft ohne Sperre. Fehler ändern nichts:
   * Dann bleibt das Gespräch offen.
   */
  async function reconcile(kennung: string): Promise<void> {
    let open: string[];
    try {
      const at = now();
      open = (await readWebSessions(kennung, paths)).sitzungen.filter((s) => isRunning(s, at) && s.gespraech !== null).map((s) => s.gespraech!);
    } catch {
      return;
    }
    for (const conversationId of open) {
      const provider = await conversationState(kennung, conversationId);
      if (provider.status === "aktiv" || provider.status === "unklar") continue;
      try {
        await applyProvider(kennung, conversationId, provider);
      } catch (e) {
        log(`[sprachagent] ${kennung} Web-Gespräch: Ende nicht übernommen (${e instanceof Error ? e.name : "Fehler"})`);
      }
    }
  }

  type Confirmed = { recipe: Recipe; tokenBis: number } | VoiceAgentSessionResult;

  /**
   * Nach dem Abruf beim Anbieter, unter derselben Sperre wie Reservierung,
   * Auflegen, Speichern und Abgleich: Die Reservierung ist noch offen und der
   * Stand unverändert, sonst kein Token und keine Freigabe. Erst dann die
   * Web-Freigabe (bruecke) und die Gesprächs-ID in der Ablage. Abgelehnt wird
   * die Reservierung zurückgenommen; eine schon abgelaufene behält ihre
   * konservative Minutenbuchung.
   */
  function confirmSlot(kennung: string, reserved: { stand: Stand; id: string }, token: { token: string; conversationId: string }): Promise<Confirmed> {
    const { conversationId } = token;
    return withAgentLock(kennung, paths, async (): Promise<Confirmed> => {
      const data = await readWebSessions(kennung, paths);
      const session = data.sitzungen.find((s) => s.id === reserved.id);
      if (!session || session.gespraech !== null || !isRunning(session, now())) return fail(409, TEXT.cancelled, "abgebrochen");
      const loaded = await loadChecked(kennung);
      const check = "blocker" in loaded ? loaded : await blockerFor(loaded.recipe);
      let refused: VoiceAgentSessionResult | null = null;
      if ("blocker" in check) refused = blocked(check.blocker);
      else if (!sameStand(check.stand, reserved.stand)) refused = fail(409, TEXT.changed, "geaendert");
      if (refused || !("recipe" in loaded)) {
        await writeWebSessions(kennung, release(data, reserved.id), paths);
        return refused ?? blocked("unbekannt");
      }
      const { recipe } = loaded;
      const ref = { kennung, conversationId };
      // Die harte Grenze richtet sich nach dem Ablauf genau dieses Tokens. Ohne
      // lesbaren oder mit zu langem Ablauf geht es nicht an den Browser: Eine
      // Annahme könnte kürzer sein als die echte Laufzeit und gäbe Platz,
      // Freigabe und Minuten zu früh frei. Ausgegeben ist nichts, also zurück.
      const tokenBis = tokenExpiry(token.token, now());
      if (tokenBis === null) {
        log(`[sprachagent] ${kennung} Web-Gespräch: Token ohne lesbaren oder mit zu langem Ablauf, nicht ausgegeben (${shortId(conversationId)})`);
        await writeWebSessions(kennung, release(data, reserved.id), paths);
        return fail(502, TEXT.tokenExpiry, "token_ablauf");
      }
      const attached = attach(data, reserved.id, conversationId, tokenBis);
      const bis = attached.sitzungen.find((s) => s.id === reserved.id)!.bis;
      try {
        // Erst die Freigabe, dann die Antwort: Die Brücke prüft sie bei jedem Turn,
        // sie gilt bis zur harten Grenze, auch bei spätem Verbinden
        if (recipe.gehirn.art === "bruecke") {
          await issueWebCall(ref, bis - now(), { ...paths, token: value("VOICE_BRIDGE_TOKEN"), now });
        }
        await writeWebSessions(kennung, attached, paths);
      } catch (e) {
        log(`[sprachagent] ${kennung} Web-Gespräch: Freigabe nicht gespeichert (${e instanceof Error ? e.name : "Fehler"})`);
        await revokeWebCall(ref, paths).catch(() => false);
        await writeWebSessions(kennung, release(data, reserved.id), paths).catch(() => {});
        return fail(503, TEXT.storage, "ablage");
      }
      return { recipe, tokenBis };
    });
  }

  async function start(kennung: string): Promise<VoiceAgentSessionResult> {
    if (!(await recipeExists(kennung))) return blocked("unbekannt");
    // Erst klären, ob ein offenes Gespräch laut Anbieter schon vorbei ist
    await reconcile(kennung);
    let reserved: Reserved;
    try {
      reserved = await reserveSlot(kennung);
    } catch (e) {
      log(`[sprachagent] ${kennung} Web-Gespräch: Reservierung gescheitert (${e instanceof Error ? e.name : "Fehler"})`);
      return fail(503, TEXT.storage, "ablage");
    }
    if ("status" in reserved) {
      log(`[sprachagent] ${kennung} Web-Gespräch: abgelehnt (${String(reserved.body.reason)})`);
      return reserved;
    }
    const { id } = reserved;
    // Nur eine noch offene Reservierung: Ein zwischenzeitliches Auflegen hat sie schon gebucht
    const dropReservation = () =>
      update(kennung, (data) => (data.sitzungen.some((s) => s.id === id && s.ende === null) ? release(data, id) : data)).catch(() => {});

    const token = await fetchToken(kennung, reserved.stand.agentId);
    if (!token) {
      await dropReservation();
      return fail(502, TEXT.provider, "anbieter");
    }
    let confirmed: Confirmed;
    try {
      confirmed = await confirmSlot(kennung, reserved, token);
    } catch (e) {
      log(`[sprachagent] ${kennung} Web-Gespräch: Bestätigung gescheitert (${e instanceof Error ? e.name : "Fehler"})`);
      await dropReservation();
      return fail(503, TEXT.storage, "ablage");
    }
    if ("status" in confirmed) {
      log(`[sprachagent] ${kennung} Web-Gespräch: nach dem Abruf abgelehnt (${String(confirmed.body.reason)})`);
      return confirmed;
    }
    const { recipe } = confirmed;
    log(`[sprachagent] ${kennung} Web-Gespräch: gestartet (${shortId(token.conversationId)}, ${recipe.gehirn.art})`);
    return {
      status: 200,
      body: {
        conversationToken: token.token,
        conversationId: token.conversationId,
        connectionType: "webrtc",
        expiresInSec: Math.max(1, Math.ceil((confirmed.tokenBis - now()) / 1000)),
        maxMinuten: recipe.zugang.maxMinuten,
      },
    };
  }

  /** Gesprächs-ID aus { conversationId }; null bei allem anderen */
  function conversationIdOf(body: string): string | null {
    let raw: any;
    try {
      raw = JSON.parse(body);
    } catch {
      return null;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !isValidConversationId(raw.conversationId)) return null;
    return raw.conversationId as string;
  }

  /**
   * Endemeldung des Browsers: nur ein Anlass, beim Anbieter nachzufragen. Nur
   * für ein offenes Gespräch mit genau dieser ID (sonst 404). Belegt der
   * Anbieter das Ende, 200 mit den gebuchten Minuten; sonst 202 ausstehend,
   * und Platz, Freigabe und volle Minuten bleiben. Nachgefragt wird nach
   * endCheckDelaysMs mehrmals, weil der Status kurz nach dem Auflegen noch
   * in-progress sein kann.
   */
  async function end(kennung: string, body: string): Promise<VoiceAgentSessionResult> {
    // Die ID erhält nur der startende Client. Ein anderer Tab kennt aus der
    // Zustandsroute nur „läuft“ und kann dessen Gespräch nicht beenden.
    const conversationId = conversationIdOf(body);
    if (conversationId === null) return fail(400, TEXT.invalid, "ungueltig");
    if (!(await recipeExists(kennung))) return blocked("unbekannt");
    let open: { bis: number } | undefined;
    try {
      const at = now();
      open = (await readWebSessions(kennung, paths)).sitzungen.find((s) => isRunning(s, at) && s.gespraech === conversationId);
    } catch (e) {
      log(`[sprachagent] ${kennung} Web-Gespräch: Ablage nicht lesbar (${e instanceof Error ? e.name : "Fehler"})`);
      return fail(503, TEXT.storage, "ablage");
    }
    if (!open) return fail(404, TEXT.noCall, "kein_gespraech");
    let settled: Settled = { status: "offen", provider: { status: "unklar" } };
    for (const delay of endCheckDelays) {
      if (delay > 0) await sleep(delay);
      const provider = await conversationState(kennung, conversationId);
      if (provider.status === "aktiv" || provider.status === "unklar") {
        settled = { status: "offen", provider };
        continue;
      }
      try {
        settled = await applyProvider(kennung, conversationId, provider);
      } catch (e) {
        const revoke = (e as { revokeFailed?: boolean }).revokeFailed === true;
        log(`[sprachagent] ${kennung} Web-Gespräch: ${revoke ? "Freigabe nicht gelöscht" : "Ende nicht gespeichert"} (${e instanceof Error ? e.name : "Fehler"})`);
        return revoke ? fail(503, TEXT.revokeFailed, "widerruf") : fail(503, TEXT.storage, "ablage");
      }
      if (settled.status !== "offen") break;
    }
    if (settled.status === "kein_gespraech") return fail(404, TEXT.noCall, "kein_gespraech");
    if (settled.status === "beendet") return { status: 200, body: { ok: true, minuten: settled.minuten } };
    const reason = settled.provider.status === "unklar" ? "anbieter_unklar" : "anbieter_aktiv";
    log(`[sprachagent] ${kennung} Web-Gespräch: Ende gemeldet, Anbieter bestätigt es nicht (${shortId(conversationId)}, ${settled.provider.status})`);
    return {
      status: 202,
      body: { ausstehend: true, reason, error: settled.provider.status === "unklar" ? TEXT.endUnknown : TEXT.endPending, bis: new Date(open.bis).toISOString() },
    };
  }

  return { page, info, start, end };
}
