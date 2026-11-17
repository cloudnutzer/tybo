/**
 * Nachlauf-Weiche für Sprachagenten (Issue #496, Entscheidung 0026).
 *
 * ElevenLabs schickt nach jedem Gespräch das Protokoll an einen Webhook je
 * Arbeitsbereich (src/app/server-routes.ts). Diese Weiche entscheidet, wem es
 * gehört:
 *   1. Gibt es das Gespräch schon in der Ablage eines Rezepts, gehört es dorthin.
 *   2. Sonst über agent_id: aktuelle, ersetzte oder frühere Agent-Kennung im
 *      Zustand eines Rezepts (state.json, bekannteAgentIds). So bleibt die
 *      Zuordnung, auch wenn ein Abgleich den Agenten ersetzt oder ihn entfernt.
 *   3. Sonst über die Gesprächs-ID eines Web-Gesprächs (web-sitzungen.json).
 *   4. Sonst wie bisher an den Anrufdienst (receiveTranscript, /anruf und
 *      Anrufe, die tybo nicht gewählt hat).
 * Lässt sich eine dieser Dateien nicht lesen, ist die Zuordnung unklar: Dann
 * wirft die Weiche (der Webhook antwortet mit 500, ElevenLabs stellt erneut zu)
 * statt das Gespräch als fremden Anruf in den Direktchat zu geben. Ausnahme ist
 * der Agent des Anrufdienstes selbst (ELEVENLABS_AGENT_ID), er geht immer dorthin.
 *
 * Ablage: data/voice-agents/<kennung>/gespraeche/<gesprächs-id>.json mit
 * Protokoll und Zustand. Angelegt wird exklusiv, eine doppelte (auch
 * gleichzeitige) Zustellung legt nichts doppelt an. Keinem symbolischen Link
 * wird gefolgt (base.ts). Ein Rezept-Gespräch geht nie in den Chat-Verlauf des
 * Nutzers und nie durch Merk-Tags.
 *
 * Nachlauf je Vorlage: Nur das Training (vorlage experte mit nachlauf.training)
 * hat einen. Jedes andere Rezept-Gespräch wird nur abgelegt und bekommt nicht
 * den Nachlauf des Anrufdienstes. Das Training läuft in Schritten, jeder
 * Schritt schreibt erst den Zustand:
 *   - Auswertung (training.ts, Aux-Zweck "voice-training"). Modellfehler und
 *     unbrauchbare Antworten werden nach EVAL_RETRY_MS wiederholt, jeweils
 *     doppelt so lange bis EVAL_RETRY_MAX_MS, höchstens MAX_EVAL_ATTEMPTS mal;
 *     danach eine kurze Meldung ohne Auswertung. Ist die Auswertung
 *     abgeschaltet (callAux meldet disabled, Claude fehlt, Issue #566), gibt
 *     es keinen neuen Versuch, sondern sofort eine Meldung mit dem Grund.
 *   - Eintrag in training.jsonl, nur wenn es für das Gespräch noch keinen gibt
 *     (Absturz zwischen Schreiben und Statuswechsel).
 *   - Meldung über die Outbox an nachlauf.ziel (display_only im Verlauf, nie
 *     als Kontext eines Modells). Die Outbox kennt keinen Idempotenzschlüssel:
 *     Vor dem Versand steht „sendet“ im Zustand. Zugestellt und unklar (auch
 *     „sendet“ nach einem Neustart) gelten als erledigt, lieber keine als eine
 *     doppelte Meldung. Nur sicher abgelehnt wird nach SEND_RETRY_MS
 *     wiederholt, höchstens MAX_SEND_ATTEMPTS mal.
 * resume() setzt beim Start alle offenen Gespräche fort.
 *
 * Ins Log kommen Kennung, Gesprächs-ID und Stand, nie Protokoll oder Auswertung.
 */
import { randomUUID } from "node:crypto";
import { link, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomic-file";
import type { AuxResult } from "../aux-model";
import type { TranscriptDelivery } from "../phone/service";
import type { TranscriptLine } from "../phone/provider";
import {
  agentDataDir,
  agentsDataRoot,
  assertFileOrMissing,
  ensureRealDirs,
  isValidKennung,
  readRegularFile,
  realDirsExist,
  recipeHash,
  VoiceAgentError,
  type VoiceAgentPaths,
} from "./base";
import { loadRecipe, type Recipe } from "./recipe";
import { readState } from "./state";
import {
  appendTrainingEntry,
  criterionHistory,
  parseTrainingAnswer,
  RATINGS,
  readTrainingLog,
  TRAINING_TEXT,
  trainingMessage,
  trainingPrompt,
  userLines,
  type TrainingEntry,
} from "./training";
import { readWebSessions } from "./web-sessions";

/** Gesprächs-IDs werden Dateinamen; ElevenLabs vergibt etwa conv_<buchstaben und ziffern> */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const EVAL_RETRY_MS = 60_000;
export const EVAL_RETRY_MAX_MS = 60 * 60_000;
export const MAX_EVAL_ATTEMPTS = 5;
export const SEND_RETRY_MS = 60_000;
export const MAX_SEND_ATTEMPTS = 3;
/** Absender der Meldung im Verlauf */
export const TRAINING_SOURCE = "training";

export type DeliveryOutcome = "delivered" | "rejected" | "unclear";
/** nachlauf.ziel eines Rezepts */
export type AftercallTarget = Recipe["nachlauf"]["ziel"];

export interface TranscriptMeta {
  /** agent_id aus dem Webhook */
  agentId?: string;
  /** Beginn des Gesprächs (ms), aus metadata.start_time_unix_secs */
  startedAt?: number;
}

export interface AftercallDeps {
  paths: VoiceAgentPaths;
  /** Anrufdienst für alles, was keinem Rezept gehört; null, solange er nicht steht */
  phone(): { receiveTranscript(conversationId: string, lines: TranscriptLine[]): Promise<TranscriptDelivery> } | null;
  /** Agent des Anrufdienstes (ELEVENLABS_AGENT_ID) */
  phoneAgentId?(): string | undefined;
  /** Auswertung; Standard callAux("voice-training", …) */
  evaluate(prompt: string): Promise<AuxResult>;
  /** Meldung an nachlauf.ziel; Werfen gilt als unklar */
  notify(target: AftercallTarget, text: string): Promise<DeliveryOutcome>;
  timeZone?: string;
  now?(): number;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  log?(line: string): void;
}

const lineSchema = z.object({ speaker: z.enum(["agent", "user"]), text: z.string() }).strict();
const criterionSchema = z.object({ text: z.string(), bewertung: z.enum(RATINGS), zitat: z.string().nullable(), begruendung: z.string() }).strict();
const recordSchema = z
  .object({
    format: z.literal(1),
    gespraech: z.string(),
    kennung: z.string(),
    agentId: z.string().nullable(),
    /** Beginn des Gesprächs, sonst Empfang (ms) */
    zeit: z.number(),
    empfangen: z.number(),
    protokoll: z.array(lineSchema),
    /** offen: Nachlauf läuft noch; fertig: nichts mehr zu tun; gescheitert: aufgegeben */
    status: z.enum(["offen", "fertig", "gescheitert"]),
    /** Was getan wurde: abgelegt (kein Nachlauf), training, leer, ohne-rezept */
    nachlauf: z.enum(["abgelegt", "training", "leer", "ohne-rezept"]).nullable(),
    versuche: z.number().int().min(0),
    naechsterVersuch: z.number().nullable(),
    auswertung: z
      .object({
        rezeptHash: z.string(),
        name: z.string(),
        ziel: z.string(),
        abschlussfrage: z.string(),
        ausgewertetAm: z.string(),
        kriterien: z.array(criterionSchema),
        selbsteinschaetzung: z.object({ zitat: z.string(), vergleich: z.string() }).strict().nullable().optional(),
        abschluss: z.string().nullable(),
      })
      .strict()
      .optional(),
    eingetragen: z.boolean().optional(),
    meldung: z
      .object({
        stand: z.enum(["offen", "sendet", "zugestellt", "unklar", "abgelehnt"]),
        versuche: z.number().int().min(0),
        /** Text und Ziel stehen fest, sobald die Meldung zum ersten Mal hinausgeht */
        text: z.string(),
        ziel: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConversationRecord = z.infer<typeof recordSchema>;

export function conversationsDir(kennung: string, paths: VoiceAgentPaths = {}): string {
  return join(agentDataDir(kennung, paths), "gespraeche");
}

function conversationDirs(kennung: string, paths: VoiceAgentPaths): string[] {
  return [agentsDataRoot(paths), agentDataDir(kennung, paths), conversationsDir(kennung, paths)];
}

export function conversationFile(kennung: string, conversationId: string, paths: VoiceAgentPaths = {}): string {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw new VoiceAgentError(`Ungültige Gesprächs-ID: ${JSON.stringify(conversationId)}`);
  return join(conversationsDir(kennung, paths), `${conversationId}.json`);
}

/** Gespräch aus der Ablage; null, wenn es keins gibt. Beschädigt ist ein Fehler. */
export async function readConversation(kennung: string, conversationId: string, paths: VoiceAgentPaths = {}): Promise<ConversationRecord | null> {
  const path = conversationFile(kennung, conversationId, paths);
  if (!(await realDirsExist(conversationDirs(kennung, paths)))) return null;
  const content = await readRegularFile(path);
  if (content === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    raw = undefined;
  }
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) throw new VoiceAgentError(`Gespräch ${conversationId} von ${kennung} ist beschädigt: ${path}`);
  return parsed.data;
}

async function writeConversation(record: ConversationRecord, paths: VoiceAgentPaths): Promise<void> {
  const path = conversationFile(record.kennung, record.gespraech, paths);
  await ensureRealDirs(conversationDirs(record.kennung, paths));
  await assertFileOrMissing(path);
  await atomicWriteFile(path, JSON.stringify(record, null, 2) + "\n");
}

/** Legt die Datei vollständig an, nur wenn es sie noch nicht gibt. false: schon da. */
async function createConversation(record: ConversationRecord, paths: VoiceAgentPaths): Promise<boolean> {
  const path = conversationFile(record.kennung, record.gespraech, paths);
  await ensureRealDirs(conversationDirs(record.kennung, paths));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await link(temp, path);
    return true;
  } catch (error: any) {
    if (error.code === "EEXIST") {
      await assertFileOrMissing(path);
      return false;
    }
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Kennungen mit Datenordner; ohne Ablageordner keine */
async function agentKennungen(paths: VoiceAgentPaths): Promise<string[]> {
  const root = agentsDataRoot(paths);
  if (!(await realDirsExist([root]))) return [];
  return (await readdir(root)).filter(isValidKennung).sort();
}

export type Owner = { kennung: string } | null;

/** Wem gehört das Gespräch? Wirft, wenn sich das wegen einer unlesbaren Datei nicht sicher sagen lässt. */
export async function findOwner(conversationId: string, meta: TranscriptMeta, paths: VoiceAgentPaths): Promise<Owner> {
  const kennungen = await agentKennungen(paths);
  const problems: string[] = [];
  const attempt = async (fn: () => Promise<boolean>, kennung: string): Promise<boolean> => {
    try {
      return await fn();
    } catch (error) {
      problems.push(`${kennung}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const validId = CONVERSATION_ID_PATTERN.test(conversationId);
  if (validId) {
    for (const kennung of kennungen) {
      if (await attempt(async () => (await readConversation(kennung, conversationId, paths)) !== null, kennung)) return { kennung };
    }
  }
  const agentId = meta.agentId;
  if (agentId) {
    for (const kennung of kennungen) {
      const owns = async () => {
        const state = await readState(kennung, paths);
        if (!state) return false;
        const ids = [state.agentId, (state as { ersetzterAgentId?: unknown }).ersetzterAgentId, ...(state.bekannteAgentIds ?? [])];
        return ids.includes(agentId);
      };
      if (await attempt(owns, kennung)) return { kennung };
    }
  }
  for (const kennung of kennungen) {
    if (await attempt(async () => (await readWebSessions(kennung, paths)).sitzungen.some((s) => s.gespraech === conversationId), kennung)) return { kennung };
  }
  if (problems.length > 0) throw new VoiceAgentError(`Zuordnung des Gesprächs unklar, Ablage der Sprachagenten nicht lesbar (${problems.join("; ")})`);
  return null;
}

export interface Aftercall {
  /** Wie receiveTranscript des Anrufdienstes, dazu agent_id und Gesprächsbeginn */
  receiveTranscript(conversationId: string, lines: TranscriptLine[], meta?: TranscriptMeta): Promise<TranscriptDelivery>;
  /** Offene Gespräche nach dem Start fortsetzen */
  resume(): Promise<void>;
  /** Wartet, bis alle laufenden Schritte fertig sind (Tests) */
  idle(): Promise<void>;
  /** Zeitgeber anhalten, ohne den Stand zu ändern (Tests: Neustart) */
  stop(): void;
}

export function createAftercall(deps: AftercallDeps): Aftercall {
  const { paths } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const setTimer =
    deps.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const running = new Map<string, Promise<void>>();
  const timers = new Map<string, unknown>();
  let stopped = false;
  const key = (kennung: string, id: string) => `${kennung}/${id}`;

  function schedule(kennung: string, id: string, at: number): void {
    if (stopped) return;
    const k = key(kennung, id);
    const old = timers.get(k);
    if (old !== undefined) clearTimer(old);
    timers.set(
      k,
      setTimer(() => {
        timers.delete(k);
        kick(kennung, id);
      }, Math.max(0, at - now())),
    );
  }

  /** Höchstens ein Durchlauf je Gespräch zur Zeit; wer währenddessen kommt, hängt sich an */
  function kick(kennung: string, id: string): Promise<void> {
    const k = key(kennung, id);
    const current = running.get(k);
    if (current) return current;
    const run = advance(kennung, id)
      .catch((error) => log(`[sprachagent] ${kennung}: Nachlauf für ${id} unterbrochen (${error instanceof Error ? error.message : "Fehler"})`))
      .finally(() => running.delete(k));
    running.set(k, run);
    return run;
  }

  async function save(record: ConversationRecord): Promise<ConversationRecord> {
    await writeConversation(record, paths);
    return record;
  }

  async function finish(record: ConversationRecord, status: "fertig" | "gescheitert", nachlauf?: ConversationRecord["nachlauf"]): Promise<void> {
    await save({ ...record, status, naechsterVersuch: null, ...(nachlauf !== undefined ? { nachlauf } : {}) });
    log(`[sprachagent] ${record.kennung}: Gespräch ${record.gespraech} ${status} (${nachlauf ?? record.nachlauf ?? "ohne Nachlauf"})`);
  }

  async function retryLater(record: ConversationRecord, why: string): Promise<void> {
    const versuche = record.versuche + 1;
    if (versuche >= MAX_EVAL_ATTEMPTS) {
      const recipe = await loadRecipe(record.kennung, paths).catch(() => null);
      const text = TRAINING_TEXT.failed(recipe?.name ?? record.kennung, record.zeit, record.kennung, deps.timeZone);
      log(`[sprachagent] ${record.kennung}: Auswertung von ${record.gespraech} aufgegeben (${why})`);
      await deliver({ ...record, versuche, naechsterVersuch: null }, text, recipe?.nachlauf.ziel ?? "direktchat", "gescheitert");
      return;
    }
    const wait = Math.min(EVAL_RETRY_MS * 2 ** (versuche - 1), EVAL_RETRY_MAX_MS);
    const next = now() + wait;
    await save({ ...record, versuche, naechsterVersuch: next });
    log(`[sprachagent] ${record.kennung}: Auswertung von ${record.gespraech} später (${why}), Versuch ${versuche}`);
    schedule(record.kennung, record.gespraech, next);
  }

  /**
   * Meldung hinaus; danach endet das Gespräch mit status. Steht schon eine
   * Meldung im Zustand, gilt deren Text und Ziel.
   */
  async function deliver(record: ConversationRecord, text: string, ziel: string, status: "fertig" | "gescheitert"): Promise<void> {
    const meldung = record.meldung ?? { stand: "offen" as const, versuche: 0, text, ziel };
    if (meldung.stand === "zugestellt" || meldung.stand === "unklar") return finish({ ...record, meldung }, status);
    if (meldung.stand === "sendet") {
      // Neustart während des Versands: ob die Meldung ankam, ist unklar
      log(`[sprachagent] ${record.kennung}: Meldung zu ${record.gespraech} nach Neustart unklar, kein zweiter Versand`);
      return finish({ ...record, meldung: { ...meldung, stand: "unklar" } }, status);
    }
    const sending = await save({ ...record, meldung: { ...meldung, stand: "sendet", versuche: meldung.versuche + 1 } });
    let outcome: DeliveryOutcome;
    try {
      outcome = await deps.notify(meldung.ziel as AftercallTarget, meldung.text);
    } catch {
      outcome = "unclear";
    }
    const versuche = meldung.versuche + 1;
    if (outcome === "delivered") return finish({ ...sending, meldung: { ...meldung, stand: "zugestellt", versuche } }, status);
    if (outcome === "unclear") {
      log(`[sprachagent] ${record.kennung}: Meldung zu ${record.gespraech} unklar, kein zweiter Versand`);
      return finish({ ...sending, meldung: { ...meldung, stand: "unklar", versuche } }, status);
    }
    if (versuche >= MAX_SEND_ATTEMPTS) {
      log(`[sprachagent] ${record.kennung}: Meldung zu ${record.gespraech} abgelehnt, aufgegeben`);
      return finish({ ...sending, meldung: { ...meldung, stand: "abgelehnt", versuche } }, "gescheitert");
    }
    const next = now() + SEND_RETRY_MS;
    await save({ ...sending, meldung: { ...meldung, stand: "abgelehnt", versuche }, naechsterVersuch: next });
    log(`[sprachagent] ${record.kennung}: Meldung zu ${record.gespraech} abgelehnt, neuer Versuch später`);
    schedule(record.kennung, record.gespraech, next);
  }

  function entryOf(record: ConversationRecord): TrainingEntry {
    const a = record.auswertung!;
    return {
      gespraech: record.gespraech,
      zeit: record.zeit,
      ausgewertetAm: a.ausgewertetAm,
      rezeptHash: a.rezeptHash,
      abschlussfrage: a.abschlussfrage,
      kriterien: a.kriterien,
      ...(a.selbsteinschaetzung !== undefined ? { selbsteinschaetzung: a.selbsteinschaetzung } : {}),
      abschluss: a.abschluss,
    };
  }

  async function advance(kennung: string, id: string): Promise<void> {
    let record = await readConversation(kennung, id, paths);
    if (!record || record.status !== "offen") return;
    if (record.naechsterVersuch !== null && record.naechsterVersuch > now()) return schedule(kennung, id, record.naechsterVersuch);

    // Meldung schon unterwegs oder abgelehnt: nur noch zustellen
    if (record.meldung) return deliver(record, record.meldung.text, record.meldung.ziel, record.auswertung || record.nachlauf === "leer" ? "fertig" : "gescheitert");

    if (!record.auswertung) {
      let recipe: Recipe | null;
      try {
        recipe = await loadRecipe(kennung, paths);
      } catch (error) {
        // Beschädigtes Rezept: liegen lassen, bis es jemand berichtigt (kein Versuch verbraucht)
        const next = now() + EVAL_RETRY_MAX_MS;
        await save({ ...record, naechsterVersuch: next });
        log(`[sprachagent] ${kennung}: Rezept nicht lesbar, Nachlauf für ${id} wartet (${error instanceof Error ? error.message : "Fehler"})`);
        return schedule(kennung, id, next);
      }
      if (!recipe) return finish(record, "fertig", "ohne-rezept");
      if (!recipe.nachlauf.training || !recipe.training) return finish(record, "fertig", "abgelegt");
      if (userLines(record.protokoll).length === 0) {
        record = await save({ ...record, nachlauf: "leer" });
        return deliver(record, TRAINING_TEXT.empty(recipe.name, record.zeit, deps.timeZone), recipe.nachlauf.ziel, "fertig");
      }
      let answer: AuxResult;
      try {
        answer = await deps.evaluate(trainingPrompt(recipe.training, record.protokoll));
      } catch {
        answer = { text: "", isError: true };
      }
      if (answer.disabled) {
        // Abgeschaltet (Issue #566): kein neuer Versuch, eine Meldung mit Grund statt einer Auswertung
        log(`[sprachagent] ${kennung}: Auswertung von ${id} abgeschaltet (Claude fehlt), keine Wiederholung`);
        return deliver(record, TRAINING_TEXT.disabled(recipe.name, record.zeit, kennung, deps.timeZone), recipe.nachlauf.ziel, "gescheitert");
      }
      if (answer.isError || !answer.text.trim()) return retryLater(record, "Modell antwortet nicht");
      const parsed = parseTrainingAnswer(answer.text, recipe.training, record.protokoll);
      if (!parsed.ok) return retryLater(record, `Antwort unbrauchbar: ${parsed.fehler}`);
      record = await save({
        ...record,
        nachlauf: "training",
        naechsterVersuch: null,
        auswertung: {
          rezeptHash: recipeHash(recipe),
          name: recipe.name,
          ziel: recipe.nachlauf.ziel,
          abschlussfrage: recipe.training.abschlussfrage,
          ausgewertetAm: new Date(now()).toISOString(),
          kriterien: parsed.result.kriterien,
          ...(parsed.result.selbsteinschaetzung !== undefined ? { selbsteinschaetzung: parsed.result.selbsteinschaetzung } : {}),
          abschluss: parsed.result.abschluss,
        },
      });
    }

    const entry = entryOf(record);
    if (!record.eingetragen) {
      await appendTrainingEntry(kennung, entry, paths);
      record = await save({ ...record, eingetragen: true });
    }
    const history = criterionHistory(await readTrainingLog(kennung, paths), entry);
    return deliver(record, trainingMessage(record.auswertung!.name, entry, history, deps.timeZone), record.auswertung!.ziel, "fertig");
  }

  return {
    async receiveTranscript(conversationId, lines, meta = {}) {
      const phoneAgent = deps.phoneAgentId?.();
      let owner: Owner;
      if (phoneAgent && meta.agentId === phoneAgent) owner = null;
      else owner = await findOwner(conversationId, meta, paths);
      if (!owner) {
        const phone = deps.phone();
        if (!phone) throw new Error("Anrufdienst nicht bereit");
        return phone.receiveTranscript(conversationId, lines);
      }
      // Gehört einem Rezept: nie an den Anrufdienst, auch wenn die ID sich nicht ablegen lässt
      const received = now();
      const created = await createConversation(
        {
          format: 1,
          gespraech: conversationId,
          kennung: owner.kennung,
          agentId: meta.agentId ?? null,
          zeit: meta.startedAt !== undefined && Number.isFinite(meta.startedAt) ? meta.startedAt : received,
          empfangen: received,
          protokoll: lines.map((line) => ({ speaker: line.speaker, text: line.text })),
          status: "offen",
          nachlauf: null,
          versuche: 0,
          naechsterVersuch: null,
        },
        paths,
      );
      log(`[sprachagent] ${owner.kennung}: Gespräch ${conversationId} ${created ? "abgelegt" : "schon bekannt"}`);
      // Nicht abwarten: die Auswertung kann dauern, der Zustand liegt schon dauerhaft
      void kick(owner.kennung, conversationId);
      return created ? "accepted" : "known";
    },

    async resume() {
      for (const kennung of await agentKennungen(paths)) {
        let files: string[];
        try {
          if (!(await realDirsExist(conversationDirs(kennung, paths)))) continue;
          files = await readdir(conversationsDir(kennung, paths));
        } catch (error) {
          log(`[sprachagent] ${kennung}: Gespräche nicht lesbar (${error instanceof Error ? error.message : "Fehler"})`);
          continue;
        }
        for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
          const id = file.slice(0, -".json".length);
          if (!CONVERSATION_ID_PATTERN.test(id)) continue;
          try {
            const record = await readConversation(kennung, id, paths);
            if (record?.status === "offen") schedule(kennung, id, record.naechsterVersuch ?? now());
          } catch (error) {
            log(`[sprachagent] ${kennung}: Gespräch ${id} nicht lesbar (${error instanceof Error ? error.message : "Fehler"})`);
          }
        }
      }
    },

    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },

    stop() {
      stopped = true;
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
    },
  };
}
