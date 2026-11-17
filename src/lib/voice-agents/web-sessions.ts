/**
 * Web-Gespräche eines Sprachagenten (Issue #494): Reservierung, Rate-Limit und
 * Minutenbudget je Rezept in data/voice-agents/<kennung>/web-sitzungen.json.
 *
 * Wahrheitsquelle ist der Anbieter, nie der Browser. Der Browser kann nicht
 * belegen, dass eine Verbindung getrennt ist oder nie zustande kommt (ein
 * hängender oder gescheiterter SDK-Aufbau kann trotzdem einen Raum offen
 * haben). Seine Endemeldung ist deshalb nur ein Anlass, beim Anbieter
 * nachzufragen (bot-voice-agent-session.ts); Sperre, Freigabe und endgültige
 * Minuten richten sich nach dessen Antwort (settle).
 *
 * - Reserviert wird vor dem Aufruf beim Anbieter, unter der Sperre der Kennung
 *   (state.ts). Zwei Starts zugleich ergeben also nie zwei Gespräche.
 * - Offen heißt: reserviert, vom Anbieter nicht als beendet bestätigt und vor
 *   bis. bis ist die harte Grenze: Bis zum Ablauf des Tokens (tokenBis) kann
 *   ein Gespräch beginnen, und es endet beim Anbieter spätestens nach
 *   maxMinuten (max_duration_seconds), dazu WEB_SESSION_SLACK_MS. Danach gibt
 *   es dieses Gespräch sicher nicht mehr, auch ohne jede Meldung. So lange
 *   gilt auch die Web-Freigabe der Brücke; solange es offen ist, gibt es kein
 *   zweites Gespräch (409).
 * - tokenBis ist immer der Ablauf, den das ausgegebene Token selbst nennt
 *   (exp), nie eine Annahme. Ein Token ohne lesbaren Ablauf oder mit einem
 *   späteren als WEB_SESSION_TOKEN_MAX_MS geht nicht an den Browser
 *   (tokenExpiry null); die Reservierung wird zurückgenommen, weil nichts
 *   ausgegeben wurde. Nur vor dem Abruf, solange noch kein Token existiert,
 *   steht vorläufig WEB_SESSION_TOKEN_MS.
 * - Beendet (settle) nur auf Nachweis des Anbieters: Status beendet (done,
 *   failed, processing) bucht dessen Dauer, aufgerundet auf ganze Minuten,
 *   mindestens eine, höchstens die reservierten; ohne Dauer bleiben die
 *   reservierten stehen. Kennt der Anbieter die Gesprächs-ID nicht, und das
 *   Token ist samt Zuschlag abgelaufen, kam das Gespräch nie zustande: null
 *   Minuten. Aktiv, unbekannt vor Tokenablauf, nicht erreichbar oder unklar:
 *   alles bleibt, wie es ist, bis bis.
 * - Rate-Limit: höchstens WEB_SESSION_RATE.limit Anfragen beim Anbieter je
 *   WEB_SESSION_RATE.windowMs und Rezept, gezählt wird jeder Versuch, auch ein
 *   gescheiterter.
 * - Minutenbudget: Jedes Gespräch bucht erst maxMinuten, nach dem bestätigten
 *   Ende die Dauer laut Anbieter; ohne Bestätigung bleibt maxMinuten stehen.
 *   Gezählt wird im Kalendermonat des Starts (Zeitzone des Rechners), ein
 *   neuer Monat beginnt bei null.
 * - Die Datei übersteht einen Neustart. Eine beschädigte Datei ist ein Fehler:
 *   Dann gibt es kein Gespräch, bis jemand sie wegräumt.
 */
import { join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { agentDataDir, agentsDataRoot, assertFileOrMissing, ensureRealDirs, readRegularFile, realDirsExist, VoiceAgentError, type VoiceAgentPaths } from "./base";

export const WEB_SESSION_RATE = { limit: 6, windowMs: 10 * 60_000 } as const;
/**
 * Vorläufiger Tokenablauf einer Reservierung, solange der Abruf beim Anbieter
 * läuft und noch kein Token ausgegeben ist (gespraech null). Mit dem Token
 * gilt dessen exp (attach). Entspricht der Laufzeit, die ElevenLabs im Token
 * nennt (exp 900 Sekunden nach Ausgabe).
 */
export const WEB_SESSION_TOKEN_MS = 15 * 60_000;
/**
 * Längste Tokenlaufzeit, für die es ein Gespräch gibt. Ein Token mit späterem
 * oder ohne lesbaren Ablauf wird nicht ausgegeben (tokenExpiry null). Darauf
 * beruht auch die längste Web-Freigabe (WEB_CALL_MAX_TTL_MS).
 */
export const WEB_SESSION_TOKEN_MAX_MS = 60 * 60_000;
/** Zuschlag auf Tokenablauf und Gesprächsende: Uhren und Laufzeit zwischen Anbieter, Browser und Server */
export const WEB_SESSION_SLACK_MS = 60_000;
const FORMAT = 1;

export interface WebSession {
  /** Kennung der Reservierung */
  id: string;
  /** Gesprächs-ID beim Anbieter; null, solange das Token noch geholt wird */
  gespraech: string | null;
  start: number;
  /** Ende, vom Anbieter bestätigt; null: offen */
  ende: number | null;
  /** Gebuchte Minuten: maxMinuten, nach dem bestätigten Ende die Dauer laut Anbieter */
  minuten: number;
  /** Harte Grenze: bis dahin gilt die Reservierung ohne Nachweis als laufend */
  bis: number;
  /** Bis dahin kann das Token ein Gespräch eröffnen */
  tokenBis: number;
}

export interface WebSessionFile {
  sitzungen: WebSession[];
  /** Zeitpunkte der Anfragen beim Anbieter im Fenster des Rate-Limits */
  versuche: number[];
}

const fileOf = (kennung: string, paths: VoiceAgentPaths) => join(agentDataDir(kennung, paths), "web-sitzungen.json");
const dirsOf = (kennung: string, paths: VoiceAgentPaths) => [agentsDataRoot(paths), agentDataDir(kennung, paths)];

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);

function isSession(value: any): value is WebSession {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    (value.gespraech === null || typeof value.gespraech === "string") &&
    isInt(value.start) &&
    (value.ende === null || isInt(value.ende)) &&
    isInt(value.minuten) &&
    value.minuten >= 0 &&
    isInt(value.bis) &&
    isInt(value.tokenBis)
  );
}

/** Ablage eines Rezepts; leer ohne Datei. Beschädigt heißt Fehler, nie „leer“. */
export async function readWebSessions(kennung: string, paths: VoiceAgentPaths = {}): Promise<WebSessionFile> {
  const path = fileOf(kennung, paths);
  if (!(await realDirsExist(dirsOf(kennung, paths)))) return { sitzungen: [], versuche: [] };
  const content = await readRegularFile(path);
  if (content === null) return { sitzungen: [], versuche: [] };
  try {
    const raw = JSON.parse(content);
    if (raw?.format === FORMAT && Array.isArray(raw.sitzungen) && raw.sitzungen.every(isSession) && Array.isArray(raw.versuche) && raw.versuche.every(isInt)) {
      return { sitzungen: raw.sitzungen, versuche: raw.versuche };
    }
  } catch {
    // unten
  }
  throw new VoiceAgentError(`Web-Gespräche von ${kennung} sind beschädigt: ${path}`);
}

export async function writeWebSessions(kennung: string, data: WebSessionFile, paths: VoiceAgentPaths = {}): Promise<void> {
  const path = fileOf(kennung, paths);
  await ensureRealDirs(dirsOf(kennung, paths));
  await assertFileOrMissing(path);
  await atomicWriteFile(path, JSON.stringify({ format: FORMAT, ...data }, null, 2) + "\n");
}

/** Beginn des Kalendermonats von now, Zeitzone des Rechners */
export function monthStart(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function nextMonthStart(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

export function isRunning(session: WebSession, now: number): boolean {
  return session.ende === null && now < session.bis;
}

export function runningSession(data: WebSessionFile, now: number): WebSession | null {
  return data.sitzungen.find((s) => isRunning(s, now)) ?? null;
}

/** Gebuchte Minuten im Monat von now */
export function usedMinutes(data: WebSessionFile, now: number): number {
  const from = monthStart(now);
  const to = nextMonthStart(now);
  return data.sitzungen.filter((s) => s.start >= from && s.start < to).reduce((sum, s) => sum + s.minuten, 0);
}

/** Entfernt, was nicht mehr zählt: Versuche außerhalb des Fensters, Gespräche vergangener Monate. */
export function prune(data: WebSessionFile, now: number): WebSessionFile {
  const from = monthStart(now);
  return {
    sitzungen: data.sitzungen.filter((s) => s.start >= from || isRunning(s, now)),
    versuche: data.versuche.filter((t) => t > now - WEB_SESSION_RATE.windowMs && t <= now),
  };
}

export type ReserveOutcome =
  | { status: "ok"; data: WebSessionFile; session: WebSession }
  | { status: "laeuft"; bis: number }
  | { status: "zu_viele"; retryAfterSec: number }
  | { status: "budget"; verbraucht: number; retryAfterSec: number };

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** Spätestes Ende eines Gesprächs, das bis tokenBis beginnt und höchstens maxMinuten dauert */
const hardLimit = (tokenBis: number, maxMinuten: number) => tokenBis + maxMinuten * 60_000 + WEB_SESSION_SLACK_MS;

/**
 * Prüft Parallelität, Rate-Limit und Budget und reserviert maxMinuten. Reine
 * Funktion: Der Aufrufer liest und schreibt unter der Sperre der Kennung.
 */
export function reserve(input: WebSessionFile, options: { now: number; id: string; maxMinuten: number; minutenMonat: number }): ReserveOutcome {
  const { now, maxMinuten, minutenMonat } = options;
  const data = prune(input, now);
  const running = runningSession(data, now);
  if (running) return { status: "laeuft", bis: running.bis };
  if (data.versuche.length >= WEB_SESSION_RATE.limit) {
    const oldest = Math.min(...data.versuche);
    return { status: "zu_viele", retryAfterSec: seconds(oldest + WEB_SESSION_RATE.windowMs - now) };
  }
  const used = usedMinutes(data, now);
  if (used + maxMinuten > minutenMonat) return { status: "budget", verbraucht: used, retryAfterSec: seconds(nextMonthStart(now) - now) };
  const tokenBis = now + WEB_SESSION_TOKEN_MS;
  const session: WebSession = {
    id: options.id,
    gespraech: null,
    start: now,
    ende: null,
    minuten: maxMinuten,
    bis: hardLimit(tokenBis, maxMinuten),
    tokenBis,
  };
  return { status: "ok", session, data: { sitzungen: [...data.sitzungen, session], versuche: [...data.versuche, now] } };
}

/** Nimmt eine Reservierung zurück (Anbieter gescheitert); der Versuch zählt weiter. */
export function release(data: WebSessionFile, id: string): WebSessionFile {
  return { ...data, sitzungen: data.sitzungen.filter((s) => s.id !== id) };
}

/**
 * Trägt die Gesprächs-ID beim Anbieter und den Ablauf genau dieses Tokens ein
 * (tokenExpiry); die harte Grenze richtet sich danach.
 */
export function attach(data: WebSessionFile, id: string, gespraech: string, tokenBis: number): WebSessionFile {
  return {
    ...data,
    sitzungen: data.sitzungen.map((s) => (s.id !== id ? s : { ...s, gespraech, tokenBis, bis: hardLimit(tokenBis, s.minuten) })),
  };
}

/**
 * Ablauf eines Gesprächs-Tokens aus seinem Inhalt (JWT, Feld exp in
 * Sekunden), nur gelesen, nicht geprüft. null, wenn der Ablauf nicht lesbar
 * ist, schon erreicht oder später als now plus WEB_SESSION_TOKEN_MAX_MS:
 * Dann wird das Token nicht ausgegeben. Nie ein angenommener Ersatzwert, denn
 * ein zu früh angenommener Ablauf gäbe Platz, Freigabe und Minuten frei,
 * während das Token noch verbinden könnte.
 */
export function tokenExpiry(token: string, now: number): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = payload?.exp;
    if (!Number.isSafeInteger(exp)) return null;
    const at = exp * 1000;
    return at > now && at <= now + WEB_SESSION_TOKEN_MAX_MS ? at : null;
  } catch {
    return null;
  }
}

/** Was der Anbieter zu einer Gesprächs-ID sagt (bot-voice-agent-session.ts) */
export type ProviderState =
  /** done, failed oder processing; Dauer in Sekunden, null: nicht angegeben */
  | { status: "beendet"; dauerSek: number | null }
  /** initiated oder in-progress */
  | { status: "aktiv" }
  /** Gesprächs-ID unbekannt (404) */
  | { status: "unbekannt" }
  /** nicht erreichbar, Fehler oder Antwort nicht lesbar */
  | { status: "unklar" };

export type SettleOutcome =
  | { status: "beendet"; data: WebSessionFile; session: WebSession }
  | { status: "offen"; session: WebSession }
  | { status: "kein_gespraech" };

/**
 * Beendet das offene Gespräch mit dieser ID nur, wenn der Anbieter es belegt:
 * beendet mit Dauer (mindestens eine Minute, höchstens die reservierten; ohne
 * Dauer die reservierten) oder unbekannt nach Tokenablauf plus Zuschlag (nie
 * zustande gekommen, null Minuten). Sonst bleibt es offen.
 */
export function settle(data: WebSessionFile, now: number, gespraech: string, provider: ProviderState): SettleOutcome {
  const session = data.sitzungen.find((s) => isRunning(s, now) && s.gespraech === gespraech);
  if (!session) return { status: "kein_gespraech" };
  let minuten: number;
  if (provider.status === "beendet") {
    minuten = provider.dauerSek === null ? session.minuten : Math.min(session.minuten, Math.max(1, Math.ceil(provider.dauerSek / 60)));
  } else if (provider.status === "unbekannt" && now >= session.tokenBis + WEB_SESSION_SLACK_MS) {
    minuten = 0;
  } else {
    return { status: "offen", session };
  }
  const ended: WebSession = { ...session, ende: now, minuten };
  return { status: "beendet", session: ended, data: { ...data, sitzungen: data.sitzungen.map((s) => (s.id === session.id ? ended : s)) } };
}
