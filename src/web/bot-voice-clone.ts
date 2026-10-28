/**
 * Echte Abhängigkeiten für „Eigene Stimme" (Issue #253) in src/bot.ts:
 * Ablage unter data/speech/voices/ (src/lib/speech/voices.ts), Klon-Engines
 * (src/lib/speech/clone.ts) und die Auswahl in config/settings.json
 * (speech.cloneVoice, speech.tts = clone, speech.telegramTts).
 *
 * Wie bot-speech.ts bindet nur src/bot.ts diese Datei ein; Tests nutzen sie
 * mit eigener Ablage, Engine-Attrappen und einer Einstellungsdatei im
 * Temp-Ordner.
 */

import { getSettings as realGetSettings, updateSettings as realUpdateSettings, type Settings } from "../lib/settings";
import { getCloneTts } from "../lib/speech";
import type { CloneTts } from "../lib/speech/clone";
import { deviceLabel, VOICE_CONSENT_TEXT, VOICE_MAX_SECONDS, VOICE_MIN_SECONDS, VOICE_PROBE_TEXT, VOICE_READING_TEXT, type VoiceRecord } from "../lib/speech/voices";
import { withTtsChoice } from "./settings";
import type { ClonedVoiceInfo, VoiceClonePort, VoiceCloneTexts } from "./voice-clone";

export interface BotVoiceCloneDeps {
  /** Standard: getCloneTts() */
  clone?: () => CloneTts;
  getSettings?: () => Settings;
  updateSettings?: (mutate: (current: Settings) => Settings) => Promise<unknown>;
  log?: (line: string) => void;
}

export const VOICE_CLONE_TEXTS: VoiceCloneTexts = {
  consent: VOICE_CONSENT_TEXT,
  reading: VOICE_READING_TEXT,
  probe: VOICE_PROBE_TEXT,
  minSeconds: VOICE_MIN_SECONDS,
  maxSeconds: VOICE_MAX_SECONDS,
};

function info(v: VoiceRecord, activeId: string | undefined): ClonedVoiceInfo {
  return { id: v.id, name: v.name, label: v.label, createdAt: v.createdAt, seconds: v.seconds, active: v.id === activeId };
}

export function createBotVoiceClone(deps: BotVoiceCloneDeps = {}): VoiceClonePort & { texts: VoiceCloneTexts } {
  const clone = deps.clone ?? getCloneTts;
  const getSettings = deps.getSettings ?? realGetSettings;
  const updateSettings = deps.updateSettings ?? (mutate => realUpdateSettings(mutate));
  const log = deps.log ?? (line => console.log(`[Web] ${line}`));

  return {
    texts: VOICE_CLONE_TEXTS,

    async list() {
      const speech = getSettings().speech ?? {};
      const voices = await clone().voices().list();
      // Eine gewählte, aber nicht (mehr) vorhandene Stimme zählt nicht als gewählt
      const active = voices.some(v => v.id === speech.cloneVoice) ? speech.cloneVoice : undefined;
      const engine = clone().engineStatus();
      return {
        voices: voices.map(v => info(v, active)),
        engine,
        inUse: speech.tts === "clone" && !!active,
        texts: VOICE_CLONE_TEXTS,
      };
    },

    async create(input) {
      const result = await clone().voices().create({
        name: input.name,
        consent: input.consent,
        device: deviceLabel(input.device),
        audio: Buffer.from(input.audio.buffer, input.audio.byteOffset, input.audio.byteLength),
      });
      if (!result.ok) return result;
      const speech = getSettings().speech ?? {};
      return { ok: true, voice: info(result.voice, speech.cloneVoice) };
    },

    async probe(id) {
      const r = await clone().probe(id, VOICE_PROBE_TEXT);
      if (!r.ok) return r;
      return { ok: true, audio: new Uint8Array(r.audio.buffer, r.audio.byteOffset, r.audio.byteLength), mime: "audio/wav" };
    },

    async use(id) {
      const voice = await clone().voices().get(id);
      if (!voice) return { ok: false, reason: "unbekannt" };
      if (!clone().activeEngine()) return { ok: false, reason: "engine" };
      try {
        // Die bisherige Wahl fürs Sprechen merken: Telegram spricht weiter damit (nie mit der eigenen Stimme)
        await updateSettings(s => ({ ...s, speech: { ...withTtsChoice(s.speech ?? {}, "clone"), cloneVoice: id } }));
      } catch (e) {
        log(`Eigene Stimme nicht eingestellt (${e instanceof Error ? e.name : typeof e})`);
        return { ok: false, reason: "settings" };
      }
      log("Eigene Stimme zum Vorlesen gewählt");
      return { ok: true };
    },

    /**
     * Erst laufende Prozesse mit der Stimme beenden, dann den Ordner löschen
     * (Referenz, Text, Einwilligung, Abgeleitetes). War sie gewählt, entfällt
     * die Auswahl und Sprechen geht zurück auf die Wahl von vor „Verwenden"
     * (speech.telegramTts; ohne sie SPEECH_TTS bzw. auto), Telegram bleibt
     * dabei unverändert.
     */
    async remove(id) {
      clone().forget(id);
      const removed = await clone().voices().remove(id);
      const speech = getSettings().speech ?? {};
      if (speech.cloneVoice === id) {
        try {
          await updateSettings(s => {
            const { cloneVoice: _gone, telegramTts: kept, ...rest } = s.speech ?? {};
            if (rest.tts !== "clone") return { ...s, speech: { ...rest, ...(kept !== undefined ? { telegramTts: kept } : {}) } };
            const { tts: _clone, ...others } = rest;
            return { ...s, speech: { ...others, ...(kept !== undefined ? { tts: kept } : {}) } };
          });
        } catch (e) {
          // Die Stimme ist weg; ohne Referenz liest der Anbieter nicht mehr vor
          log(`Auswahl der gelöschten Stimme nicht entfernt (${e instanceof Error ? e.name : typeof e})`);
        }
      }
      return removed;
    },
  };
}
