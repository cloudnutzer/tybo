/**
 * Schlanker Kontext fuer Sprachgespraeche: Agent-Prompt, Profil, Memory und
 * die letzten Nachrichten, einmal pro Gespraech geladen (Cache mit TTL),
 * nicht pro Turn. Aus src/voice-bridge.ts herausgelöst (Issue #255).
 *
 * Der Cache gilt je Chat-ID und Topic: die Brücke ruft mit TELEGRAM_USER_ID
 * ohne Topic, der Telefonhörer später mit Chat und Topic des Gesprächs.
 * Alle Daten kommen über deps, damit Tests ohne Datenbank auskommen.
 */

export interface VoiceContextMessage {
  role: string;
  content: string;
  created_at?: string;
}

export interface VoiceContextDeps {
  getUserProfile: () => Promise<string>;
  getMemoryContext: () => Promise<string>;
  getRecentMessages: (chatId: string, limit: number, topicId?: number | null) => Promise<VoiceContextMessage[]>;
  /** Zeitzone fuer "CURRENT TIME", Standard Europe/Berlin */
  timeZone?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface VoiceContextOptions {
  agent: { systemPrompt: string };
  /** Lebensdauer eines geladenen Kontexts, Standard 10 Minuten */
  ttlMs?: number;
  deps: VoiceContextDeps;
}

export interface VoiceContext {
  load(chatId: string, topicId?: number | null): Promise<string>;
  /** Mit Topic nur dieses, ohne Topic alle Einträge der Chat-ID (z. B. nach neuen Merk-Einträgen) */
  invalidate(chatId: string, topicId?: number | null): void;
}

export const VOICE_CONTEXT_TTL_MS = 10 * 60_000;
const RECENT_LIMIT = 20;

function relTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 60 / 24)}d`;
}

const cacheKey = (chatId: string, topicId?: number | null) => `${chatId}\u0000${topicId ?? ""}`;

export function createVoiceContext({ agent, ttlMs = VOICE_CONTEXT_TTL_MS, deps }: VoiceContextOptions): VoiceContext {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { text: string; at: number }>();

  async function build(chatId: string, topicId?: number | null): Promise<string> {
    const [profile, memory, recent] = await Promise.all([
      deps.getUserProfile().catch(() => ""),
      deps.getMemoryContext().catch(() => ""),
      chatId
        ? (topicId == null ? deps.getRecentMessages(chatId, RECENT_LIMIT) : deps.getRecentMessages(chatId, RECENT_LIMIT, topicId)).catch(() => [])
        : Promise.resolve([]),
    ]);
    const at = now();
    const recentText = recent
      .map((m) => `[${relTime(m.created_at, at)}] ${m.role === "user" ? "User" : "Bot"}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n");
    const time = new Date(at).toLocaleString("de-DE", { timeZone: deps.timeZone || "Europe/Berlin", dateStyle: "full", timeStyle: "short" });
    return [
      agent.systemPrompt,
      profile ? `## USER PROFILE\n${profile}` : "",
      `## CURRENT TIME\n${time}`,
      memory ? `## MEMORY\n${memory}` : "",
      recentText ? `## RECENT TELEGRAM CONVERSATION\n${recentText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");
  }

  return {
    async load(chatId, topicId) {
      const key = cacheKey(chatId, topicId);
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.text;
      const started = now();
      const text = await build(chatId, topicId);
      cache.set(key, { text, at: now() });
      deps.log?.(`Kontext geladen: ${text.length} Zeichen in ${now() - started} ms`);
      return text;
    },
    invalidate(chatId, topicId) {
      if (topicId != null) {
        cache.delete(cacheKey(chatId, topicId));
        return;
      }
      const prefix = `${chatId}\u0000`;
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
    },
  };
}
