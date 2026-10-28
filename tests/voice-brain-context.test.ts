/**
 * Issue #255: gemeinsame Bausteine der Sprach-Brücke in src/lib/voice-brain/.
 * Kontext-Cache je Chat-ID (und Topic) und Sprechstil; die Brücke selbst
 * prüft src/lib/voice-bridge/bridge.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { createVoiceContext, type VoiceContextDeps } from "../src/lib/voice-brain/context";
import { CALL_MISHEARING_HINT, voiceStyle } from "../src/lib/voice-brain/style";

// Wortlaut der Brücke vor dem Umzug (bridge.ts, Stand webui vor #255)
const PHONE_STYLE_BEFORE =
  "Du bist gerade im Sprachgespraech (Voice-Agent Mia). Du sprichst, du schreibst nicht: " +
  "Antworte in ein bis drei gesprochenen Saetzen, ausser der Nutzer will ausdruecklich mehr. " +
  "Keine Aufzaehlungen, keine Markdown-Zeichen, keine URLs vorlesen, keine Emojis. Zahlen so nennen, wie man sie sagt. " +
  "Wenn dir Kontext aus frueheren Gespraechen fehlt, nutze history_search, statt zu raten. " +
  "Wenn eine Frage echte Analyse braucht, die laenger als eine halbe Minute dauert, nutze deep_think, statt den Nutzer warten zu lassen. " +
  "Merk-Tags wie [REMEMBER: ...] oder [GOAL: ...] darfst du ans Ende setzen; sie werden nicht vorgelesen. " +
  "[INVOKE:...]-Tags funktionieren hier nicht, lass sie weg.";

describe("voiceStyle", () => {
  test("phone ist Zeichen für Zeichen der bisherige Text der Brücke", () => {
    expect(voiceStyle({ agentName: "Mia", channel: "phone" })).toBe(PHONE_STYLE_BEFORE);
  });

  test("call verlangt kurze Antworten, Zahlen wie gesprochen und kein Rechnen aus dem Stand", () => {
    const call = voiceStyle({ agentName: "Mia", channel: "call" });
    expect(call).toContain("Voice-Agent Mia");
    expect(call).toContain("ein bis zwei kurzen Sätzen");
    expect(call).toContain("300 Zeichen");
    expect(call).toContain("ausdrücklich");
    expect(call).toContain("so, wie man sie spricht");
    expect(call).toContain("Rechne nichts im Kopf aus");
    // Werkzeuge als Tags (Issue #259), nie als Function Calling der Brücke
    expect(call).not.toContain("history_search");
    expect(call).not.toContain("deep_think");
    expect(call).toContain("[RECHNE:");
    expect(call).toContain("[REMEMBER:");
    // Ohne bereite Suche und ohne Chat-Kern: keine Tags dafür
    expect(call).not.toContain("[SUCHE:");
    expect(call).not.toContain("[DENKAUFTRAG:");
  });

  test("call nennt den Spracherkenner und verlangt bei Verhörern eine kurze Rückfrage (Issue #278)", () => {
    for (const tools of [undefined, { search: true, deepTask: true }]) {
      const call = voiceStyle({ agentName: "Mia", channel: "call", tools });
      expect(call).toContain(CALL_MISHEARING_HINT);
      expect(call).toContain("Spracherkenners");
      expect(call).toContain("Verhörer");
      expect(call).toContain("verschluckte Laute");
      expect(call).toContain("falsch getrennte oder zusammengezogene Wörter");
      expect(call).toContain("ähnlich klingende Wörter");
      expect(call).toContain("mit dem wahrscheinlichsten Wort nach");
      expect(call).toContain("rate nicht");
      // Rückfrage beendet den Turn: nichts auf Basis der Vermutung
      expect(call).toContain("kein Denkauftrag auf Basis deiner Vermutung");
      // Eindeutiger Sinn: direkt antworten, Verhörer nicht erwähnen
      expect(call).toContain("Ist der Sinn eindeutig, antworte direkt und erwähne den Verhörer nicht.");
    }
  });

  test("phone (Sprach-Brücke) bekommt die Verhörer-Regel nicht", () => {
    const phone = voiceStyle({ agentName: "Mia", channel: "phone" });
    expect(phone).not.toContain("Verhörer");
    expect(phone).not.toContain("Spracherkenner");
  });

  test("call mit Suche und Denkauftrag beschreibt beide Tags", () => {
    const call = voiceStyle({ agentName: "Mia", channel: "call", tools: { search: true, deepTask: true } });
    expect(call).toContain("[SUCHE:");
    expect(call).toContain("[DENKAUFTRAG:");
    expect(call).toContain("[RECHNE:");
    expect(call).toContain("Höchstens zwei Werkzeuge");
  });
});

function fakeDeps(start = Date.UTC(2026, 9, 1, 10, 0)) {
  let clock = start;
  const calls: { chatId: string; topicId?: number | null; args: number }[] = [];
  const loads = { profile: 0, memory: 0 };
  const deps: VoiceContextDeps = {
    getUserProfile: async () => (loads.profile++, "Alex, Berlin"),
    getMemoryContext: async () => (loads.memory++, "- Alex mag Tee"),
    getRecentMessages: async (chatId, _limit, ...rest) => {
      calls.push({ chatId, topicId: rest[0], args: 2 + rest.length });
      return [
        { role: "user", content: `Frage in ${chatId}/${rest[0] ?? "-"}`, created_at: new Date(clock - 5 * 60_000).toISOString() },
        { role: "assistant", content: "Antwort   mit\nLeerraum", created_at: new Date(clock - 3 * 3600_000).toISOString() },
      ];
    },
    timeZone: "Europe/Berlin",
    now: () => clock,
  };
  return { deps, calls, loads, advance: (ms: number) => (clock += ms) };
}

describe("createVoiceContext", () => {
  const agent = { systemPrompt: "Du bist der General-Agent." };

  test("Inhalt wie bisher in der Brücke: Agent-Prompt, Profil, Zeit, Memory, letzte Nachrichten", async () => {
    const { deps } = fakeDeps();
    const text = await createVoiceContext({ agent, deps }).load("100");
    const parts = text.split("\n\n---\n\n");
    expect(parts[0]).toBe("Du bist der General-Agent.");
    expect(parts[1]).toBe("## USER PROFILE\nAlex, Berlin");
    expect(parts[2]).toStartWith("## CURRENT TIME\nDonnerstag, 1. Oktober 2026");
    expect(parts[3]).toBe("## MEMORY\n- Alex mag Tee");
    expect(parts[4]).toBe("## RECENT TELEGRAM CONVERSATION\n[5m] User: Frage in 100/-\n[3h] Bot: Antwort mit Leerraum");
  });

  test("Cache je Chat-ID: zweiter Aufruf aus dem Cache, andere Chat-ID lädt eigen", async () => {
    const { deps, calls, loads } = fakeDeps();
    const ctx = createVoiceContext({ agent, deps });
    const a1 = await ctx.load("100");
    const a2 = await ctx.load("100");
    expect(a2).toBe(a1);
    expect(loads.profile).toBe(1);
    const b = await ctx.load("200");
    expect(b).toContain("Frage in 200/-");
    expect(b).not.toContain("Frage in 100");
    expect(calls.map((c) => c.chatId)).toEqual(["100", "200"]);
    // Ohne Topic wie die Brücke: getRecentMessages(chatId, 20) ohne dritten Wert
    expect(calls[0].args).toBe(2);
  });

  test("Topics derselben Chat-ID haben getrennte Einträge", async () => {
    const { deps, calls } = fakeDeps();
    const ctx = createVoiceContext({ agent, deps });
    expect(await ctx.load("-100", 7)).toContain("Frage in -100/7");
    expect(await ctx.load("-100", 9)).toContain("Frage in -100/9");
    expect(await ctx.load("-100", 7)).toContain("Frage in -100/7");
    expect(calls.map((c) => c.topicId)).toEqual([7, 9]);
  });

  test("TTL: nach Ablauf wird neu geladen, davor nicht", async () => {
    const { deps, loads, advance } = fakeDeps();
    const ctx = createVoiceContext({ agent, ttlMs: 10 * 60_000, deps });
    await ctx.load("100");
    advance(10 * 60_000 - 1);
    await ctx.load("100");
    expect(loads.profile).toBe(1);
    advance(1);
    await ctx.load("100");
    expect(loads.profile).toBe(2);
  });

  test("invalidate: ohne Topic alle Einträge der Chat-ID, mit Topic nur dieses", async () => {
    const { deps, calls } = fakeDeps();
    const ctx = createVoiceContext({ agent, deps });
    await ctx.load("100");
    await ctx.load("100", 7);
    await ctx.load("200");
    ctx.invalidate("100", 7);
    await ctx.load("100");
    await ctx.load("100", 7);
    expect(calls.length).toBe(4);
    ctx.invalidate("100");
    await ctx.load("100");
    await ctx.load("100", 7);
    await ctx.load("200");
    expect(calls.map((c) => `${c.chatId}/${c.topicId ?? "-"}`)).toEqual(["100/-", "100/7", "200/-", "100/7", "100/-", "100/7"]);
  });

  test("Fehler einer Quelle lassen nur ihren Abschnitt weg", async () => {
    const { deps } = fakeDeps();
    const text = await createVoiceContext({
      agent,
      deps: { ...deps, getMemoryContext: async () => Promise.reject(new Error("db weg")), getRecentMessages: async () => Promise.reject(new Error("db weg")) },
    }).load("100");
    expect(text).not.toContain("## MEMORY");
    expect(text).not.toContain("## RECENT");
    expect(text).toContain("## USER PROFILE");
  });
});
