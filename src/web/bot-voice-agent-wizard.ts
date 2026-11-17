/**
 * Wizard für Sprachagenten im Bot (Issue #514): verbindet die Routen aus
 * ./voice-agent-wizard.ts mit dem Vorschlag (src/lib/voice-agents/wizard.ts),
 * der Ablage (wizard-store.ts) und demselben Entwurfsdienst wie /sprachagent
 * neu. Nur der Bot verdrahtet das (src/app/bot-web.ts).
 *
 * Festlegungen:
 * - Vorschlag: Nebenmodell voice-wizard, höchstens 20 Sekunden. Höchstens
 *   WIZARD_PROPOSALS_PER_WINDOW Vorschläge in WIZARD_PROPOSAL_WINDOW_MS (auch
 *   gescheiterte) und einer zur Zeit, sonst 429 mit Retry-After in Sekunden.
 *   Gezählt wird im Prozess: Es gibt nur einen Nutzer, ein Neustart setzt das
 *   Fenster zurück.
 * - Kosten: estimateCost (cost.ts) für die aktuelle Auswahl; ohne gewähltes
 *   Gehirn gilt das der Vorlage.
 * - Stimme: Der Entwurf meldet nur, ob eine Standardstimme eingestellt ist,
 *   nie ihre Kennung. Eingefroren wird sie beim Bauen wie bei /sprachagent neu.
 * - Stimmenliste und Hörprobe (Issue #515): Stimmen des Kontos über voices()
 *   (im Bot listProviderVoices), höchstens WIZARD_VOICES_CACHE_MS
 *   zwischengespeichert. Die Hörprobe spricht nur Kennungen dieser Liste oder
 *   die Standardstimme, mit festem Text (KI-Hinweis der gewählten Sprache),
 *   höchstens WIZARD_PROBES_PER_WINDOW in WIZARD_PROBE_WINDOW_MS (auch
 *   gescheiterte) und eine zur Zeit, Zeitlimit WIZARD_PROBE_TIMEOUT_MS. Der Ton
 *   wird nicht gespeichert. Mit einer Stimme des Kontos prüft Bauen, ob es sie
 *   noch gibt.
 * - Fortschritt (Issue #515): Ergebnis des Testlaufs dieses Entwurfs (über
 *   testRunId), offene Rückfrage, Freischaltung und Web-Zugang des angelegten
 *   Rezepts. Fertige und abgebrochene Wizards bleiben WIZARD_RECENT_MS in der
 *   Liste, damit sich ihr Ergebnis wieder öffnen lässt.
 */
import type { ChoiceConversation } from "../lib/choices";
import { estimateCost, type PriceLoad } from "../lib/voice-agents/cost";
import { FINAL_PHASES, type DraftRecord, type DraftService } from "../lib/voice-agents/drafts";
import { resolveVoice, defaultVoiceSources, type VoiceSources } from "../lib/voice-agents/recipe";
import { TEMPLATES } from "../lib/voice-agents/templates";
import type { VoiceAgentPaths } from "../lib/voice-agents/base";
import { pcmToWav } from "../lib/speech/pcm";
import { ELEVENLABS_STREAM_RATE, streamElevenLabs } from "../lib/speech/elevenlabs";
import { tagWavAiGenerated } from "../lib/speech/wav";
import { readTestRun } from "../lib/voice-agents/manage";
import { loadRecipe } from "../lib/voice-agents/recipe";
import { isUnlocked } from "../lib/voice-agents/unlock";
import type { ProviderVoice } from "../lib/voice-agents/voice-catalog";
import { fieldsView, fixedEntries, fixedRulesByTemplate, kiHinweisFor, proposeWizard, receptionRules, WIZARD_DEFAULT_TEMPLATE, WIZARD_SENTENCE_MAX, type ProposalAsk, type WizardFields } from "../lib/voice-agents/wizard";
import { createWizardStore, type WizardEntry, type WizardFailure, type WizardStore } from "../lib/voice-agents/wizard-store";
import { VOICE_WIZARD_TEXT as TEXT, type VoiceWizardPort, type VoiceWizardResult } from "./voice-agent-wizard";

export const WIZARD_PROPOSALS_PER_WINDOW = 10;
export const WIZARD_PROPOSAL_WINDOW_MS = 10 * 60_000;
export const WIZARD_PROBES_PER_WINDOW = 10;
export const WIZARD_PROBE_WINDOW_MS = 10 * 60_000;
export const WIZARD_PROBE_TIMEOUT_MS = 15_000;
export const WIZARD_VOICES_CACHE_MS = 60_000;
/** So lange stehen fertige und abgebrochene Wizards noch in der Liste */
export const WIZARD_RECENT_MS = 7 * 24 * 3_600_000;

/** Ton der Hörprobe; wirft bei Fehlern, signal bricht ab */
export type WizardSpeak = (input: { voiceId: string; text: string; language: string; signal: AbortSignal }) => Promise<{ bytes: Uint8Array; type: string }>;

/**
 * Hörprobe bei ElevenLabs mit genau dieser Stimme (Text zu Sprache, PCM in
 * 24 kHz, als WAV mit KI-Kennzeichnung). undefined ohne Schlüssel.
 */
export function elevenLabsSpeak(env: Record<string, string | undefined>, fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): WizardSpeak | undefined {
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) return undefined;
  return async ({ voiceId, text, language, signal }) => {
    const parts: Uint8Array[] = [];
    for await (const chunk of streamElevenLabs(fetchFn, text, { key, voice: voiceId, language, signal })) parts.push(chunk);
    const pcm = Buffer.concat(parts);
    return { bytes: new Uint8Array(tagWavAiGenerated(pcmToWav(pcm, ELEVENLABS_STREAM_RATE))), type: "audio/wav" };
  };
}

export interface VoiceAgentWizardOptions {
  drafts: Pick<DraftService, "reserveWizard" | "startWizard" | "discardWizard" | "read" | "ablageDir">;
  paths: VoiceAgentPaths;
  /** Nebenmodell; im Bot callAux("voice-wizard", …) */
  ask: ProposalAsk;
  /** Wohin Rückfragen und Meldungen des Entwurfs gehen (im Bot der Direktchat) */
  conversation(): ChoiceConversation;
  prices(): Promise<PriceLoad>;
  voiceSources?(): VoiceSources;
  /** Stimmen des Kontos beim Anbieter; leer ohne Anbieter oder bei Fehler */
  voices?(): Promise<ProviderVoice[]>;
  /** Hörprobe beim Anbieter; fehlt sie, antwortet die Route mit 503 */
  speak?: WizardSpeak;
  probeTimeoutMs?: number;
  proposalTimeoutMs?: number;
  now?(): number;
  log?(line: string): void;
}

const ok = (body: Record<string, unknown>, status = 200): VoiceWizardResult => ({ status, body });
const fail = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}): VoiceWizardResult => ({ status, body: { error, reason, ...extra } });

/** Rückfrage, die zur Phase gehört (Schritt der Rückfrage im Entwurfsdienst) */
const QUESTION_OF: Partial<Record<DraftRecord["phase"], "stimme" | "freigabe" | "freischalten" | "fortsetzen">> = {
  stimme: "stimme",
  freigabe: "freigabe",
  durchgefallen: "freischalten",
  unterbrochen: "fortsetzen",
};

/** Phase in Klartext für die Oberfläche */
const PHASE_TEXT: Record<DraftRecord["phase"], string> = {
  wizard: "Entwurf, noch nicht gebaut",
  job: "Der Job schreibt Rezept und Tests",
  stimme: "Stimmwahl offen im Direktchat",
  freigabe: "Freigabe offen im Direktchat",
  anlegen: "Wird angelegt und getestet",
  fertig: "Fertig",
  durchgefallen: "Tests durchgefallen, Entscheidung offen im Direktchat",
  unterbrochen: "Unterbrochen, „Erneut versuchen“ offen im Direktchat",
  verworfen: "Verworfen",
  abgebrochen: "Abgebrochen",
};

/** Erster Satz, höchstens 300 Zeichen, ohne Zeilenumbrüche; ohne Text undefined */
function oneSentence(text: string | undefined): string | undefined {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const first = clean.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? clean;
  return first.length > 300 ? `${first.slice(0, 299)}…` : first;
}

export function failure(f: WizardFailure): VoiceWizardResult {
  switch (f.code) {
    case "unbekannt":
      return fail(404, TEXT.unknown, "unbekannt");
    case "ungueltig":
      return fail(400, TEXT.shape, "ungueltig", { fehler: f.fehler });
    case "fest":
      return fail(422, TEXT.fixed, "fest", { fehler: f.fehler });
    case "existiert":
      return fail(409, TEXT.exists, "existiert");
    case "vergeben":
      return fail(409, TEXT.taken, "vergeben");
    case "belegt":
      return fail(409, TEXT.occupied, "belegt");
    case "kennung":
      return fail(422, TEXT.badKennung, "kennung");
    case "veraltet":
      return fail(409, TEXT.stale, "veraltet", { revision: f.revision });
    case "gebaut":
      return fail(409, TEXT.building, "gebaut", { phase: f.phase });
    case "unvollstaendig":
      return fail(422, TEXT.incomplete, "unvollstaendig", { fehler: f.fehler });
    case "nur_revision":
      return fail(422, TEXT.buildOnly, "nur_revision");
    case "zu_viele":
      return fail(409, TEXT.tooMany, "zu_viele");
    case "anhang_typ":
      return fail(415, TEXT.attachmentType, "anhang_typ");
    case "anhang_gross":
      return fail(413, TEXT.attachmentLarge, "zu_gross");
    case "anhang_zahl":
      return fail(409, TEXT.attachmentCount, "anhang_zahl");
    case "anhang_leer":
      return fail(400, TEXT.empty, "leer");
    case "anhang_unbekannt":
      return fail(404, TEXT.attachmentUnknown, "anhang_unbekannt");
    case "fehler":
      return fail(500, TEXT.failed, "fehler");
  }
}

export function createVoiceAgentWizard(options: VoiceAgentWizardOptions): VoiceWizardPort & { store: WizardStore } {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.log(line));
  const voiceSources = options.voiceSources ?? defaultVoiceSources;
  const store = createWizardStore({ drafts: options.drafts, paths: options.paths, conversation: options.conversation, now, log });
  const recent: number[] = [];
  let proposing = false;

  function standardVoiceId(): string | null {
    const resolved = resolveVoice({ stimme: { art: "bibliothek", modell: "", tempo: 1 } } as never, voiceSources());
    return "voiceId" in resolved ? resolved.voiceId : null;
  }
  const standardVoice = () => standardVoiceId() !== null;

  let voiceCache: { at: number; list: ProviderVoice[] } | null = null;
  async function accountVoices(fresh = false): Promise<ProviderVoice[]> {
    if (!options.voices) return [];
    if (!fresh && voiceCache && now() - voiceCache.at < WIZARD_VOICES_CACHE_MS) return voiceCache.list;
    const list = await options.voices().catch(() => [] as ProviderVoice[]);
    voiceCache = { at: now(), list };
    return list;
  }
  const probes: number[] = [];
  let probing = false;

  async function cost(felder: WizardFields) {
    const template = TEMPLATES[felder.vorlage ?? WIZARD_DEFAULT_TEMPLATE];
    const gehirn = { art: felder.gehirn?.art ?? template.defaults.gehirn.art, modell: felder.gehirn?.modell ?? template.defaults.gehirn.modell };
    const load = await options.prices().catch(() => ({ status: "ungueltig" }) as PriceLoad);
    return estimateCost({ gehirn, ...(felder.zugang?.maxMinuten !== undefined ? { maxMinuten: felder.zugang.maxMinuten } : {}), telefon: Boolean(felder.zugang?.telefon) }, load);
  }

  async function view(entry: WizardEntry): Promise<Record<string, unknown>> {
    const { wizard, record } = entry;
    return {
      kennung: wizard.kennung,
      revision: wizard.revision,
      phase: record.phase,
      phaseText: PHASE_TEXT[record.phase],
      ...(wizard.satz ? { satz: wizard.satz } : {}),
      schritt: wizard.schritt ?? 1,
      felder: fieldsView(wizard.felder),
      ...(wizard.offen ? { offen: wizard.offen } : {}),
      ...(receptionRules(wizard.felder).length ? { anruferRegeln: receptionRules(wizard.felder) } : {}),
      feste: fixedEntries(wizard.felder),
      festeRegeln: fixedRulesByTemplate(),
      anhaenge: wizard.anhaenge.map(({ datei, name, mime, bytes }) => ({ datei, name, mime, bytes })),
      kosten: await cost(wizard.felder),
      stimme: wizard.felder.stimme
        ? { standard: standardVoice(), gewaehlt: true, text: "Im Wizard gewählt; nach dem Bauen fragt tybo nicht mehr nach der Stimme." }
        : standardVoice()
        ? { standard: true, text: "Standardstimme aus den Einstellungen; passt eine Stimme des Kontos besser, fragt tybo nach dem Bauen im Direktchat." }
        : { standard: false, text: "Keine Standardstimme eingestellt (Einstellungen, Sprache). Ohne Stimme scheitert das Anlegen." },
      erstelltAm: wizard.erstelltAm,
      geaendertAm: wizard.geaendertAm,
      ...(entry.festFehler.length ? { festFehler: entry.festFehler } : {}),
    };
  }

  async function propose(body: unknown): Promise<VoiceWizardResult> {
    const satz = (body as { satz?: unknown } | null)?.satz;
    if (typeof satz !== "string" || !satz.trim() || satz.trim().length > WIZARD_SENTENCE_MAX) return fail(400, TEXT.needSentence, "satz");
    const at = now();
    while (recent.length && recent[0] <= at - WIZARD_PROPOSAL_WINDOW_MS) recent.shift();
    if (proposing) return { ...fail(429, TEXT.busy, "beschaeftigt"), headers: { "Retry-After": "5" } };
    if (recent.length >= WIZARD_PROPOSALS_PER_WINDOW) {
      const wait = Math.max(1, Math.ceil((recent[0] + WIZARD_PROPOSAL_WINDOW_MS - at) / 1000));
      return { ...fail(429, TEXT.rateLimited, "rate_limit"), headers: { "Retry-After": String(wait) } };
    }
    recent.push(at);
    proposing = true;
    try {
      const proposal = await proposeWizard(satz.trim(), options.ask, options.proposalTimeoutMs);
      log(`[sprachagent] Wizard: Vorschlag ${proposal.quelle}`);
      return ok({
        vorschlag: { kennung: proposal.kennung, satz: satz.trim(), felder: fieldsView(proposal.felder), feste: fixedEntries(proposal.felder), festeRegeln: fixedRulesByTemplate(), kosten: await cost(proposal.felder) },
        quelle: proposal.quelle,
        ...(proposal.hinweis ? { hinweis: proposal.hinweis } : {}),
      });
    } finally {
      proposing = false;
    }
  }

  async function list(): Promise<VoiceWizardResult> {
    const r = await store.list({ recentMs: WIZARD_RECENT_MS });
    if (!r.ok) return failure(r);
    const item = ({ wizard, record }: WizardEntry) => ({
      kennung: wizard.kennung,
      name: wizard.felder.name ?? null,
      vorlage: wizard.felder.vorlage ?? null,
      phase: record.phase,
      phaseText: PHASE_TEXT[record.phase],
      revision: wizard.revision,
      // Vor dem Bauen der zuletzt bearbeitete Schritt, danach Prüfen und Starten
      schritt: record.phase === "wizard" ? (wizard.schritt ?? 1) : 5,
      geaendertAm: wizard.geaendertAm,
    });
    const final = (e: WizardEntry) => FINAL_PHASES.includes(e.record.phase);
    return ok({ entwuerfe: r.value.filter((e) => !final(e)).map(item), beendet: r.value.filter(final).map(item) });
  }

  async function get(kennung: string): Promise<VoiceWizardResult> {
    const r = await store.get(kennung);
    return r.ok ? ok(await view(r.value)) : failure(r);
  }

  async function put(kennung: string, body: unknown): Promise<VoiceWizardResult> {
    const r = await store.save(kennung, body);
    if (!r.ok) return r.code === "unbekannt" && (body as any)?.revision === undefined ? fail(422, TEXT.badKennung, "kennung") : failure(r);
    return ok(await view(r.value.entry), r.value.created ? 201 : 200);
  }

  async function remove(kennung: string): Promise<VoiceWizardResult> {
    const r = await store.remove(kennung);
    return r.ok ? ok({ ok: true }) : failure(r);
  }

  async function rename(kennung: string, body: unknown): Promise<VoiceWizardResult> {
    const r = await store.rename(kennung, body);
    return r.ok ? ok(await view(r.value)) : failure(r);
  }

  async function build(kennung: string, body: unknown): Promise<VoiceWizardResult> {
    // Eine Stimme des Kontos muss es noch geben; sonst scheiterte das Anlegen erst nach dem Job
    if (options.voices) {
      const current = await store.get(kennung);
      const chosen = current.ok ? current.value.wizard.felder.stimme : undefined;
      if (chosen?.wahl === "konto" && !(await accountVoices(true)).some((v) => v.voiceId === chosen.voiceId)) {
        return fail(422, TEXT.incomplete, "unvollstaendig", { fehler: [TEXT.voiceGone] });
      }
    }
    const r = await store.build(kennung, body);
    if (!r.ok) return failure(r);
    return ok({ ok: true, entwurf: r.value.entwurf, phase: "job", text: "Der Entwurf wird gebaut. Stimmwahl und Freigabe kommen als Rückfrage in den Direktchat." }, 202);
  }

  async function progress(kennung: string): Promise<VoiceWizardResult> {
    const r = await store.get(kennung);
    if (!r.ok) return failure(r);
    const { record, wizard } = r.value;
    return ok({
      kennung: wizard.kennung,
      phase: record.phase,
      phaseText: PHASE_TEXT[record.phase],
      versuch: record.versuch,
      ...(record.fehler?.length ? { fehler: record.fehler } : {}),
      ...(record.grund ? { grund: record.grund } : {}),
      rueckfrageOffen: Boolean(record.choiceId),
      ...(QUESTION_OF[record.phase] ? { rueckfrage: QUESTION_OF[record.phase] } : {}),
      ...(record.uebernommen ? { version: record.uebernommen.version } : {}),
      ...(await built(wizard.kennung, record)),
    });
  }

  /** Was nach dem Anlegen feststeht: Testergebnisse, Freischaltung, Web-Zugang */
  async function built(kennung: string, record: DraftRecord): Promise<Record<string, unknown>> {
    if (record.phase === "wizard" || record.phase === "job") return { freigeschaltet: false, web: false };
    let web = false;
    try {
      web = record.uebernommen ? Boolean((await loadRecipe(kennung, options.paths))?.zugang.web?.link) : false;
    } catch {
      web = false;
    }
    const freigeschaltet = record.uebernommen ? await isUnlocked(kennung, options.paths) : false;
    const out: Record<string, unknown> = { freigeschaltet, web };
    if (record.testRunId) {
      const run = await readTestRun(kennung, record.testRunId, options.paths);
      if (run === "laufend") out.tests = { status: "laufend", liste: [] };
      else if (!run) out.tests = { status: "fehlt", liste: [], text: "Das Ergebnis des Testlaufs liegt nicht (mehr) vor." };
      else
        out.tests = {
          status: run.ergebnis,
          liste: run.tests.map((t) => ({
            name: t.name,
            status: t.status,
            ...(t.status === "durchgefallen" ? { grund: oneSentence(t.kriterium) ?? "Der Anbieter nennt keine Begründung." } : {}),
          })),
          ...(run.grund ? { grund: oneSentence(run.grund) } : {}),
        };
    }
    return out;
  }

  async function voices(): Promise<VoiceWizardResult> {
    const list = await accountVoices();
    const standardOk = standardVoice();
    return ok({
      standard: standardOk ? { standard: true, name: "Standardstimme" } : null,
      ...(standardOk ? {} : { standardText: "Keine Standardstimme eingestellt (Einstellungen, Sprache). Ohne Stimme scheitert das Anlegen." }),
      konto: list.map((v) => ({ voiceId: v.voiceId, name: v.name, klon: v.category === "cloned" })),
      ...(list.length ? {} : { hinweis: TEXT.voicesEmpty }),
    });
  }

  async function probe(body: unknown): Promise<VoiceWizardResult> {
    const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const keys = b ? Object.keys(b) : [];
    const sprache = b?.sprache;
    const wantsStandard = b?.standard === true && b.voiceId === undefined;
    const wantsVoice = typeof b?.voiceId === "string" && b.standard === undefined;
    if (!b || keys.some((k) => !["voiceId", "standard", "sprache"].includes(k)) || (!wantsStandard && !wantsVoice) || (sprache !== undefined && (typeof sprache !== "string" || !/^[a-z]{2}$/.test(sprache)))) {
      return fail(400, TEXT.probeShape, "ungueltig");
    }
    if (!options.speak) return fail(503, TEXT.probeNoProvider, "kein_anbieter");
    let voiceId: string | null;
    if (wantsStandard) {
      voiceId = standardVoiceId();
      if (!voiceId) return fail(422, TEXT.probeNoStandard, "keine_standardstimme");
    } else {
      voiceId = (await accountVoices()).some((v) => v.voiceId === b.voiceId) ? (b.voiceId as string) : null;
      if (!voiceId) return fail(422, TEXT.probeUnknownVoice, "unbekannte_stimme");
    }
    const at = now();
    while (probes.length && probes[0] <= at - WIZARD_PROBE_WINDOW_MS) probes.shift();
    if (probing) return { ...fail(429, TEXT.probeTooMany, "beschaeftigt"), headers: { "Retry-After": "5" } };
    if (probes.length >= WIZARD_PROBES_PER_WINDOW) {
      const wait = Math.max(1, Math.ceil((probes[0] + WIZARD_PROBE_WINDOW_MS - at) / 1000));
      return { ...fail(429, TEXT.probeTooMany, "zu_viele"), headers: { "Retry-After": String(wait) } };
    }
    probes.push(at);
    probing = true;
    const language = typeof sprache === "string" ? sprache : "de";
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve("timeout");
      }, options.probeTimeoutMs ?? WIZARD_PROBE_TIMEOUT_MS);
    });
    try {
      const speaking = options.speak({ voiceId, text: kiHinweisFor([language]), language, signal: abort.signal }).catch(() => null);
      const result = await Promise.race([speaking, timeout]);
      if (result === "timeout") return fail(504, TEXT.probeTimeout, "zeitlimit");
      if (!result || !result.bytes.length) return fail(502, TEXT.probeFailed, "fehlgeschlagen");
      log(`[sprachagent] Wizard: Hörprobe ${wantsStandard ? "Standardstimme" : "Kontostimme"}`);
      return { status: 200, body: {}, audio: result };
    } finally {
      clearTimeout(timer);
      probing = false;
    }
  }

  async function addAttachment(kennung: string, name: string | undefined, bytes: Uint8Array): Promise<VoiceWizardResult> {
    const r = await store.addAttachment(kennung, name, bytes);
    if (!r.ok) return failure(r);
    const { datei, name: shown, mime, bytes: size } = r.value.anhang;
    return ok({ anhang: { datei, name: shown, mime, bytes: size }, revision: r.value.revision }, 201);
  }

  async function removeAttachment(kennung: string, datei: string): Promise<VoiceWizardResult> {
    const r = await store.removeAttachment(kennung, datei);
    return r.ok ? ok({ ok: true, revision: r.value.revision }) : failure(r);
  }

  return { store, propose, list, get, put, remove, rename, build, progress, addAttachment, removeAttachment, voices, probe };
}
