/**
 * Warnung, wenn Nachrichten ohne Embedding gespeichert werden (30.9.2026,
 * seit Issue #309 hier statt in supabase.ts). Vom 9.9. an lehnte
 * store-telegram-message den Bot mit 401 ab, und drei Wochen lang landeten
 * Nachrichten still ohne Vektor. Seitdem steht jeder Rückfall mit
 * HTTP-Status im Fehler-Log, und der Nutzer bekommt höchstens einmal pro
 * Stunde eine Warnung. Still bleiben (nur einmal im Log): 404 (Function
 * nicht ausgeliefert, semantische Suche nicht eingerichtet) und bewusst ohne
 * Embedding (kein-zugang, gesperrt während einer Neuberechnung).
 */

export const EDGE_FALLBACK_WARN_INTERVAL_MS = 60 * 60 * 1000;

/** embedding_status der Edge Function ohne Vektor, die keine Störung bedeuten */
const QUIET_EMBEDDING_STATUS = new Set(["ok", "kein-zugang", "gesperrt"]);

const state = {
  notify: null as ((text: string) => void) | null,
  lastWarnAt: 0,
  problemsSinceWarn: 0,
  /** Gründe, die schon einmal still im Log standen */
  logged: new Set<string>(),
};

/** Empfänger der stündlichen Warnung (der Bot: an den Nutzer); null schaltet ab */
export function setEdgeFallbackNotifier(fn: ((text: string) => void) | null): void {
  state.notify = fn;
}

/** Nur für Tests: Zählung und Sperrfrist zurücksetzen */
export function resetEdgeFallbackWarning(): void {
  state.lastWarnAt = 0;
  state.problemsSinceWarn = 0;
  state.logged.clear();
}

/** true beim ersten Mal je Grund, danach false */
function firstTime(reason: string): boolean {
  if (state.logged.has(reason)) return false;
  state.logged.add(reason);
  return true;
}

function warnUser(reason: string, now: number): void {
  state.problemsSinceWarn++;
  const blocked = state.lastWarnAt !== 0 && now - state.lastWarnAt < EDGE_FALLBACK_WARN_INTERVAL_MS;
  if (blocked) return;
  const count = state.problemsSinceWarn;
  state.lastWarnAt = now;
  state.problemsSinceWarn = 0;
  const repeat = count > 1 ? ` (${count}x seit der letzten Warnung)` : "";
  const text = [
    `⚠️ Nachrichten werden ohne Embedding gespeichert: ${reason}${repeat}.`,
    "Die semantische Suche findet neue Nachrichten nicht.",
    "Prüfen: bun run health, Schlüssel in .env und die Secrets der Edge Functions (tybo setup suche).",
  ].join(" ");
  console.warn(`[saveMessage] ${text}`);
  try {
    state.notify?.(text);
  } catch {
    // Die Warnung ist Zusatz und darf das Speichern nie stören
  }
}

/**
 * Rückfall auf den Direkt-Insert melden. status ist der HTTP-Status der
 * Edge Function oder null bei Netzfehler; detail ist dann der Fehler (nur
 * sein Name kommt ins Log), sonst ein kurzer Zusatz. Weder Schlüssel noch
 * Adresse landen im Log.
 */
export function reportEdgeFallback(status: number | null, detail?: unknown, now: number = Date.now()): void {
  if (status === 404) {
    if (firstTime("404")) {
      console.error("[saveMessage] Edge Function store-telegram-message fehlt (HTTP 404), speichere ohne Embedding");
    }
    return;
  }
  let what: string;
  if (status === null) what = `nicht erreichbar (${detail instanceof Error ? detail.name : "Fehler"})`;
  else what = typeof detail === "string" ? `HTTP ${status}, ${detail}` : `HTTP ${status}`;
  console.error(`[saveMessage] Edge Function store-telegram-message: ${what}, Direkt-Insert ohne Embedding`);
  warnUser(`Edge Function store-telegram-message antwortet ${what}`, now);
}

/**
 * Antwort der Edge Function nach erfolgreichem Speichern prüfen: embedded
 * false mit einem Störungsgrund warnt wie ein Rückfall, ein bewusster Grund
 * steht einmal im Log. Die Nachricht ist in beiden Fällen gespeichert.
 */
export function noteEdgeResult(body: unknown, now: number = Date.now()): void {
  if (body === null || typeof body !== "object") return;
  const { embedded, embedding_status: reason } = body as { embedded?: unknown; embedding_status?: unknown };
  if (embedded !== false || typeof reason !== "string") return;
  if (!QUIET_EMBEDDING_STATUS.has(reason)) {
    console.error(`[saveMessage] Edge Function hat ohne Embedding gespeichert (${reason})`);
    warnUser(`die Edge Function erzeugt keinen Vektor (${reason})`, now);
    return;
  }
  if (firstTime(reason)) console.warn(`[saveMessage] Nachricht ohne Embedding gespeichert (${reason})`);
}
