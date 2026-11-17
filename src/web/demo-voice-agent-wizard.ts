/**
 * Attrappe des Wizards für Sprachagenten in web:dev (Issue #515): dieselben
 * Routen und Antworten wie ./bot-voice-agent-wizard.ts, aber im Speicher,
 * ohne Anbieter, ohne Job und ohne src/lib (web:dev importiert nur src/web).
 *
 * Steuerung über den Satz aus Schritt 1 (Kleinschreibung egal):
 * - Vorschlag: „scheitern“ ergibt keinen Vorschlag (leere Felder, Vorlage
 *   experte, Hinweis); „langsam“ antwortet erst nach slowMs; „anruf“,
 *   „telefon“ oder „empfang“ wählt anrufannahme, „jarvis“, „assistent“ oder
 *   „persönlich“ jarvis, sonst experte.
 * - Bauen: Die Phasen laufen nach der Uhr, auch bei geschlossener Seite:
 *   job, ohne Stimme im Wizard stimme, freigabe (die Rückfrage im Direktchat
 *   gilt nach stepMs als beantwortet, damit der Ablauf weiterläuft), anlegen,
 *   dann je nach Satz fertig (alle Tests bestanden, freigeschaltet),
 *   „durchfallen“: durchgefallen mit offener Rückfrage „Trotzdem
 *   freischalten“, „unterbrechen“: unterbrochen mit „Erneut versuchen“,
 *   „abbrechen“: abgebrochen nach dem Job mit Prüfungsfehlern.
 * - Stimmen: Standardstimme und drei Stimmen des Kontos; die Hörprobe liefert
 *   für jede Stimme der Liste denselben kurzen Ton, nur bei „Nora“ scheitert
 *   sie wie beim Anbieter (502), damit sich der Fehlerzustand zeigen lässt.
 *
 * Ein fertiger, freigeschalteter Agent wird über register in die
 * Sprachagenten-Attrappe übernommen, damit „Sprechen“ eine Gesprächsseite
 * findet.
 */
import { VOICE_WIZARD_TEXT as TEXT, type VoiceWizardPort, type VoiceWizardResult } from "./voice-agent-wizard";

const KENNUNG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = ["session", "rezept", "test", "link", "loeschen", "vorschlag", "entwuerfe", "stimmen", "hoerprobe"];
const VORLAGEN = ["anrufannahme", "jarvis", "experte"] as const;
type Vorlage = (typeof VORLAGEN)[number];
type Phase = "wizard" | "job" | "stimme" | "freigabe" | "anlegen" | "fertig" | "durchgefallen" | "unterbrochen" | "verworfen" | "abgebrochen";

const KI = { de: "Hallo, hier spricht eine KI, ein automatischer Sprachassistent.", en: "Hello, this is an AI, an automated voice assistant." };
const BASE_RULES = [
  "KI-Hinweis: Sprichst du mit jemandem, den du nicht kennst, sagst du zuerst, dass du eine KI bist.",
  "Notfall: Schildert jemand einen Notfall, sagst du sofort: „Bitte wählen Sie 112.“ und beendest das Gespräch.",
];
const RULES: Record<Vorlage, string[]> = {
  anrufannahme: [...BASE_RULES, "Privates: Du gibst nichts über den Nutzer heraus."],
  jarvis: [...BASE_RULES, "Prüfung: Solange die Prüfung des Anrufers nicht bestanden ist, nennst du nichts aus dem Gedächtnis."],
  experte: [...BASE_RULES, "Wissen: Weißt du etwas nicht sicher, sagst du das und erfindest nichts."],
};
const RULES_BY_TEMPLATE = { basis: BASE_RULES, ...RULES };
const MEMORY: Record<Vorlage, string> = { anrufannahme: "keins", jarvis: "voll", experte: "thema" };

const PHASE_TEXT: Record<Phase, string> = {
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
const QUESTION: Partial<Record<Phase, string>> = { stimme: "stimme", freigabe: "freigabe", durchgefallen: "freischalten", unterbrochen: "fortsetzen" };

/** Stimme, deren Hörprobe in der Attrappe scheitert */
const PROBE_FAILS = "demo-nora";
const VOICES = [
  { voiceId: "demo-mia", name: "Mia", klon: false },
  { voiceId: "demo-alex", name: "Alex", klon: true },
  { voiceId: PROBE_FAILS, name: "Nora", klon: false },
];

interface Draft {
  kennung: string;
  revision: number;
  satz?: string;
  schritt: number;
  felder: Record<string, any>;
  /** Unfertige Eingaben (Prüfung von PR #558), getrennt von felder */
  offen?: { links?: string[]; telefon?: { nummer: string; anrufer: string; pin?: boolean } };
  anhaenge: { datei: string; name: string; mime: string; bytes: number }[];
  erstelltAm: string;
  geaendertAm: string;
  /** Start des Bauens (ms); null vor dem Bauen */
  gebautAm: number | null;
  verworfen: boolean;
}

/** Ein kurzer, leiser Ton als WAV (PCM16 mono, 8 kHz, 0,4 s) */
export function demoProbeWav(): Uint8Array {
  const rate = 8_000;
  const samples = rate * 0.4;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3_000 * Math.min(1, (samples - i) / 400)), true);
  return new Uint8Array(buf);
}

export interface DemoWizardOptions {
  now?(): number;
  /** Dauer je Phase nach dem Bauen */
  stepMs?: number;
  /** Wartezeit eines „langsamen“ Vorschlags */
  slowMs?: number;
  /** Kennungen, die schon ein Sprachagent hat (Beispielagenten): für den Wizard vergeben */
  taken?(kennung: string): boolean;
  /** Fertiger, freigeschalteter Agent: in die Sprachagenten-Attrappe übernehmen */
  register?(agent: { kennung: string; name: string; vorlage: string; zweck: string; web: boolean; telefon: boolean }): void;
}

const ok = (body: Record<string, unknown>, status = 200): VoiceWizardResult => ({ status, body });
const fail = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}): VoiceWizardResult => ({ status, body: { error, reason, ...extra } });

export function createDemoVoiceAgentWizard(options: DemoWizardOptions = {}): VoiceWizardPort {
  const now = options.now ?? (() => Date.now());
  const stepMs = options.stepMs ?? 2_000;
  const slowMs = options.slowMs ?? 4_000;
  const taken = (kennung: string) => options.taken?.(kennung) ?? false;
  const drafts = new Map<string, Draft>();
  const registered = new Set<string>();
  let attachmentCounter = 0;
  let proposing = false;
  const probes: number[] = [];

  const scenario = (d: Draft) => (d.satz ?? "").toLowerCase();
  const vorlageOf = (d: Draft): Vorlage => (VORLAGEN.includes(d.felder.vorlage) ? d.felder.vorlage : "experte");

  /** Phasen nach dem Bauen, nach der Uhr */
  function timeline(d: Draft): Phase[] {
    const s = scenario(d);
    if (s.includes("abbrechen")) return ["job", "abgebrochen"];
    const head: Phase[] = ["job", ...(d.felder.stimme ? [] : (["stimme"] as Phase[])), "freigabe", "anlegen"];
    if (s.includes("durchfallen")) return [...head, "durchgefallen"];
    if (s.includes("unterbrechen")) return [...head, "unterbrochen"];
    return [...head, "fertig"];
  }

  function phaseOf(d: Draft): Phase {
    if (d.verworfen) return "verworfen";
    if (d.gebautAm === null) return "wizard";
    const steps = timeline(d);
    const index = Math.min(steps.length - 1, Math.floor((now() - d.gebautAm) / stepMs));
    const phase = steps[index]!;
    if (phase === "fertig" && !registered.has(d.kennung)) {
      registered.add(d.kennung);
      options.register?.({ kennung: d.kennung, name: d.felder.name ?? d.kennung, vorlage: vorlageOf(d), zweck: d.felder.zweck ?? "", web: Boolean(d.felder.zugang?.web), telefon: Boolean(d.felder.zugang?.telefon) });
    }
    return phase;
  }

  function memory(f: Record<string, any>): string | undefined {
    const v: Vorlage | undefined = VORLAGEN.includes(f.vorlage) ? f.vorlage : undefined;
    if (!v) return f.gedaechtnis;
    if (v === "anrufannahme" || v === "experte") return MEMORY[v];
    if (f.zugang?.telefon?.anrufer === "alle") return "keins";
    return f.gedaechtnis ?? MEMORY[v];
  }

  /** Feste Werte wie applyFixed: KI-Hinweis, Gedächtnis, PIN; Regeln nur die eigenen */
  function normalize(input: Record<string, any>): { ok: true; felder: Record<string, any> } | { ok: false; result: VoiceWizardResult } {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, result: fail(400, TEXT.shape, "ungueltig", { fehler: ["felder: erwartet ein Objekt"] }) };
    const f = structuredClone(input);
    const fehler: string[] = [];
    if (f.vorlage !== undefined && !VORLAGEN.includes(f.vorlage)) fehler.push(`vorlage: erlaubt sind ${VORLAGEN.join(", ")}`);
    if (typeof f.name === "string" && f.name.length > 100) fehler.push("name: höchstens 100 Zeichen");
    if (typeof f.zweck === "string" && f.zweck.length > 1000) fehler.push("zweck: höchstens 1000 Zeichen");
    const fragen = f.anrufannahme?.fragen;
    if (Array.isArray(fragen) && (fragen.length > 8 || fragen.some((q: unknown) => typeof q !== "string" || !q.trim() || q.length > 200))) fehler.push("anrufannahme.fragen: höchstens 8, je 200 Zeichen");
    if (typeof f.anrufannahme?.abschlusssatz === "string" && f.anrufannahme.abschlusssatz.length > 466) fehler.push("anrufannahme.abschlusssatz: höchstens 466 Zeichen");
    const kriterien = f.training?.kriterien;
    if (Array.isArray(kriterien) && kriterien.length > 3) fehler.push("training.kriterien: höchstens 3 Einträge");
    if (f.zugang?.telefon && !/^[A-Za-z0-9_-]{1,64}$/.test(String(f.zugang.telefon.nummer ?? ""))) fehler.push("zugang.telefon.nummer: ungültige Kennung der Nummer");
    if (f.stimme?.wahl === "konto" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(f.stimme.voiceId ?? ""))) fehler.push("stimme.voiceId: ungültige Stimmen-Kennung");
    if (fehler.length) return { ok: false, result: fail(400, TEXT.shape, "ungueltig", { fehler }) };
    const vorlage: Vorlage | undefined = f.vorlage;
    const fixed = new Set(Object.values(RULES).flat());
    const own = (Array.isArray(f.regeln) ? f.regeln : []).map((r: any) => (typeof r === "string" ? r : r?.fest ? null : r?.text)).filter((r: unknown): r is string => typeof r === "string" && r.trim() !== "" && !fixed.has(r.trim()));
    // Wie checkFixed: Wer Regeln schickt, schickt die festen der Vorlage mit
    if (Array.isArray(f.regeln)) {
      const sent = f.regeln.map((r: any) => String(typeof r === "string" ? r : r?.text ?? "").trim());
      const missing = (vorlage ? RULES[vorlage] : BASE_RULES).filter((r) => !sent.includes(r));
      if (missing.length) return { ok: false, result: fail(422, TEXT.fixed, "fest", { fehler: missing.map((r) => `regeln: feste Regel fehlt, sie lässt sich nicht abschalten: ${r.slice(0, 60)}`) }) };
    }
    if (vorlage === "anrufannahme" && f.gedaechtnis !== undefined && f.gedaechtnis !== "keins") return { ok: false, result: fail(422, TEXT.fixed, "fest", { fehler: ["gedaechtnis: fest, die Anrufannahme hat immer keins"] }) };
    const out: Record<string, any> = { ...f, persona: { ...(f.persona ?? {}), kiHinweis: f.persona?.sprachen?.[0] === "en" ? KI.en : KI.de } };
    delete out.regeln;
    if (own.length) out.regeln = own;
    const m = memory(out);
    if (m === undefined) delete out.gedaechtnis;
    else out.gedaechtnis = m;
    if (out.gedaechtnis === "voll" && out.zugang?.telefon) out.zugang = { ...out.zugang, telefon: { ...out.zugang.telefon, pin: true } };
    return { ok: true, felder: out };
  }

  function feste(f: Record<string, any>) {
    const vorlage: Vorlage | undefined = VORLAGEN.includes(f.vorlage) ? f.vorlage : undefined;
    const out: { feld: string; wert: unknown; fest: true; grund: string }[] = [
      { feld: "persona.kiHinweis", wert: f.persona?.kiHinweis ?? KI.de, fest: true, grund: "KI-Hinweis als erster Satz jedes Gesprächs" },
      ...(vorlage ? RULES[vorlage] : BASE_RULES).map((r) => ({ feld: "regeln", wert: r, fest: true as const, grund: r.startsWith("Notfall") ? "Notfall-Regel 112" : "Feste Regel der Vorlage" })),
    ];
    if (vorlage === "anrufannahme") out.push({ feld: "gedaechtnis", wert: "keins", fest: true, grund: "Die Anrufannahme spricht mit Fremden und hat kein Gedächtnis" });
    else if (vorlage === "experte") out.push({ feld: "gedaechtnis", wert: "thema", fest: true, grund: "Der Experte stützt sich auf sein recherchiertes Wissen, nicht auf Ihr Gedächtnis" });
    else if (f.zugang?.telefon?.anrufer === "alle") out.push({ feld: "gedaechtnis", wert: "keins", fest: true, grund: "Wer jeden anrufen lässt, spricht mit Fremden: kein Gedächtnis" });
    if (f.gedaechtnis === "voll" && f.zugang?.telefon) out.push({ feld: "zugang.telefon.pin", wert: true, fest: true, grund: "Gedächtnis voll am Telefon nur mit PIN" });
    return out;
  }

  function cost(f: Record<string, any>) {
    const bridge = f.vorlage === "jarvis" && f.gehirn?.art !== "anbieter";
    const perMinute = 0.08 + (bridge ? 0 : 0.012) + (f.zugang?.telefon ? 0.01 : 0);
    const max = f.zugang?.maxMinuten;
    const perCall = !bridge && typeof max === "number" ? Math.round(perMinute * max * 10_000) / 10_000 : null;
    return {
      status: "ok",
      waehrung: "USD",
      jeMinute: Math.round(perMinute * 10_000) / 10_000,
      jeGespraech: perCall,
      credits: { jeMinute: Math.ceil(perMinute * 5_500), jeGespraech: perCall === null ? null : Math.ceil(perCall * 5_500), tarif: "Creator" },
      hinweise: ["Im Plan enthaltene Minuten sind nicht abgezogen", ...(bridge ? ["Gehirn über die Brücke: Es rechnet über tybos eigenen Motor ab und ist nicht enthalten"] : []), ...(typeof max === "number" ? [] : ["Ohne maxMinuten keine Schätzung je Gespräch"])],
      stand: "2026-11-07",
      quellen: ["https://elevenlabs.io/pricing/agents"],
    };
  }

  function receptionRules(f: Record<string, any>): string[] {
    if (f.vorlage !== "anrufannahme" || !f.anrufannahme) return [];
    return [...(f.anrufannahme.fragen ?? []).map((q: string) => `Frage den Anrufer nach: ${q}`), ...(f.anrufannahme.abschlusssatz ? [`Beende das Gespräch mit dem Satz: ${f.anrufannahme.abschlusssatz}`] : [])];
  }

  function view(d: Draft): Record<string, unknown> {
    const phase = phaseOf(d);
    const f = d.felder;
    const vorlage: Vorlage | undefined = VORLAGEN.includes(f.vorlage) ? f.vorlage : undefined;
    return {
      kennung: d.kennung,
      revision: d.revision,
      phase,
      phaseText: PHASE_TEXT[phase],
      ...(d.satz ? { satz: d.satz } : {}),
      schritt: d.schritt,
      ...(d.offen ? { offen: d.offen } : {}),
      felder: { ...f, regeln: [...(vorlage ? RULES[vorlage] : BASE_RULES).map((text) => ({ text, fest: true })), ...(f.regeln ?? []).map((text: string) => ({ text, fest: false }))] },
      ...(receptionRules(f).length ? { anruferRegeln: receptionRules(f) } : {}),
      feste: feste(f),
      festeRegeln: RULES_BY_TEMPLATE,
      anhaenge: d.anhaenge,
      kosten: cost(f),
      stimme: f.stimme ? { standard: true, gewaehlt: true, text: "Im Wizard gewählt; nach dem Bauen fragt tybo nicht mehr nach der Stimme." } : { standard: true, text: "Standardstimme aus den Einstellungen; passt eine Stimme des Kontos besser, fragt tybo nach dem Bauen im Direktchat." },
      erstelltAm: d.erstelltAm,
      geaendertAm: d.geaendertAm,
    };
  }

  const editable = (kennung: string): Draft | VoiceWizardResult => {
    const d = drafts.get(kennung);
    if (!d || d.verworfen) return fail(404, TEXT.unknown, "unbekannt");
    const phase = phaseOf(d);
    if (phase !== "wizard") return fail(409, TEXT.building, "gebaut", { phase });
    return d;
  };
  const isResult = (v: Draft | VoiceWizardResult): v is VoiceWizardResult => "status" in v;
  const touch = (d: Draft) => {
    d.revision += 1;
    d.geaendertAm = new Date(now()).toISOString();
  };

  function proposal(satz: string) {
    const s = satz.toLowerCase();
    if (s.includes("scheitern")) {
      const felder = { vorlage: "experte", persona: { kiHinweis: KI.de }, gedaechtnis: "thema" };
      return ok({
        vorschlag: { kennung: "", satz, felder: { ...felder, regeln: RULES.experte.map((text) => ({ text, fest: true })) }, feste: feste(felder), festeRegeln: RULES_BY_TEMPLATE, kosten: cost(felder) },
        quelle: "leer",
        hinweis: "Kein Vorschlag: Das Nebenmodell hat nicht geantwortet. Die Felder sind leer, die Vorlage ist experte.",
      });
    }
    const vorlage: Vorlage = /anruf|telefon|empfang/.test(s) ? "anrufannahme" : /jarvis|assistent|persönlich/.test(s) ? "jarvis" : "experte";
    const base = {
      anrufannahme: {
        name: "Empfang Praxis",
        kennung: "empfang-praxis",
        zweck: "Nimmt Anrufe an, wenn niemand abhebt, und notiert Rückrufwünsche.",
        persona: { rolle: "Freundlicher Empfang", anrede: "sie", sprachen: ["de"], ersterSatz: "Womit kann ich helfen?" },
        anrufannahme: { fragen: ["Name des Anrufers", "Rückrufnummer", "Anliegen in einem Satz"], abschlusssatz: "Vielen Dank, wir melden uns." },
      },
      jarvis: {
        name: "Jarvis Zuhause",
        kennung: "jarvis-zuhause",
        zweck: "Persönlicher Assistent für Termine, Notizen und kurze Fragen.",
        persona: { rolle: "Ruhiger persönlicher Assistent", anrede: "du", sprachen: ["de"], ersterSatz: "Was liegt an?" },
        gehirn: { denkauftrag: false },
      },
      experte: {
        name: "Verhandlungstrainer",
        kennung: "verhandlungstrainer",
        zweck: "Übt Preisverhandlungen mit einem kritischen Einkäufer.",
        persona: { rolle: "Kritischer Einkäufer", anrede: "sie", sprachen: ["de"], ersterSatz: "Ich habe zehn Minuten, legen Sie los." },
        training: { rollen: ["Einkäufer", "Controller"], einwaende: ["Zu teuer", "Wir haben schon einen Anbieter"], kriterien: ["Fragt nach dem Bedarf", "Nennt einen Nutzen in Zahlen", "Vereinbart einen nächsten Schritt"] },
        thema: "Preisverhandlung im Einkauf",
      },
    }[vorlage];
    const { kennung, ...rest } = base;
    const felder = { vorlage, ...rest, persona: { ...rest.persona, kiHinweis: KI.de }, gedaechtnis: MEMORY[vorlage] };
    return ok({
      vorschlag: { kennung, satz, felder: { ...felder, regeln: RULES[vorlage].map((text) => ({ text, fest: true })) }, feste: feste(felder), festeRegeln: RULES_BY_TEMPLATE, kosten: cost(felder) },
      quelle: "modell",
    });
  }

  /** Unfertige Eingaben wie wizardOpenSchema; undefined ohne, null bei falscher Form */
  function openInputs(value: unknown): Draft["offen"] | null {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const o = value as Record<string, any>;
    if (Object.keys(o).some((k) => k !== "links" && k !== "telefon")) return null;
    if (o.links !== undefined && !(Array.isArray(o.links) && o.links.length <= 10 && o.links.every((l: unknown) => typeof l === "string" && l.length <= 500))) return null;
    const t = o.telefon;
    if (t !== undefined && !(t && typeof t === "object" && typeof t.nummer === "string" && t.nummer.length <= 64 && ["alle", "freigegeben"].includes(t.anrufer))) return null;
    return o.links?.length || t ? { ...(o.links?.length ? { links: o.links } : {}), ...(t ? { telefon: t } : {}) } : undefined;
  }

  const tests = (d: Draft, phase: Phase) => {
    if (phase === "durchgefallen")
      return {
        status: "durchgefallen",
        liste: [
          { name: "Notfall", status: "bestanden" },
          { name: "KI-Hinweis zuerst", status: "durchgefallen", grund: "Der Agent nannte den KI-Hinweis erst nach der Begrüßung." },
          { name: "Nichts erfinden", status: "bestanden" },
        ],
      };
    if (phase === "unterbrochen") return { status: "zeitueberschreitung", liste: [], grund: "Kein Testergebnis in der Frist." };
    if (phase === "fertig")
      return {
        status: "bestanden",
        liste: [
          { name: "Notfall", status: "bestanden" },
          { name: "KI-Hinweis zuerst", status: "bestanden" },
          { name: vorlageOf(d) === "experte" ? "Bleibt in der Rolle" : "Nichts Privates", status: "bestanden" },
        ],
      };
    return undefined;
  };

  return {
    async propose(body) {
      const satz = (body as { satz?: unknown } | null)?.satz;
      if (typeof satz !== "string" || !satz.trim() || satz.trim().length > 500) return fail(400, TEXT.needSentence, "satz");
      if (proposing) return { ...fail(429, TEXT.busy, "beschaeftigt"), headers: { "Retry-After": "5" } };
      proposing = true;
      try {
        await new Promise((r) => setTimeout(r, satz.toLowerCase().includes("langsam") ? slowMs : 300));
        return proposal(satz.trim());
      } finally {
        proposing = false;
      }
    },
    async list() {
      const all = [...drafts.values()].filter((d) => !d.verworfen).sort((a, b) => b.geaendertAm.localeCompare(a.geaendertAm));
      const item = (d: Draft) => {
        const phase = phaseOf(d);
        return { kennung: d.kennung, name: d.felder.name ?? null, vorlage: d.felder.vorlage ?? null, phase, phaseText: PHASE_TEXT[phase], revision: d.revision, schritt: phase === "wizard" ? d.schritt : 5, geaendertAm: d.geaendertAm };
      };
      const final = (d: Draft) => ["fertig", "abgebrochen"].includes(phaseOf(d));
      return ok({ entwuerfe: all.filter((d) => !final(d)).map(item), beendet: all.filter(final).map(item) });
    },
    async get(kennung) {
      const d = drafts.get(kennung);
      return d && !d.verworfen ? ok(view(d)) : fail(404, TEXT.unknown, "unbekannt");
    },
    async put(kennung, body) {
      const b = (body ?? {}) as { revision?: unknown; satz?: unknown; schritt?: unknown; felder?: unknown; offen?: unknown };
      const keys = Object.keys(b);
      if (keys.some((k) => !["revision", "satz", "schritt", "felder", "offen"].includes(k))) return fail(400, TEXT.shape, "ungueltig", { fehler: ["Erwartet { revision?, satz?, schritt?, felder, offen? }"] });
      const offen = openInputs(b.offen);
      if (offen === null) return fail(400, TEXT.shape, "ungueltig", { fehler: ["offen: erwartet { links?, telefon? }"] });
      if (b.schritt !== undefined && !(Number.isInteger(b.schritt) && (b.schritt as number) >= 1 && (b.schritt as number) <= 5)) return fail(400, TEXT.shape, "ungueltig", { fehler: ["schritt: 1 bis 5"] });
      const checked = normalize((b.felder ?? {}) as Record<string, any>);
      if (!checked.ok) return checked.result;
      const at = new Date(now()).toISOString();
      if (b.revision === undefined) {
        if (!KENNUNG.test(kennung) || RESERVED.includes(kennung) || kennung.length > 64) return fail(422, TEXT.badKennung, "kennung");
        const current = drafts.get(kennung);
        if (current && !current.verworfen && !["fertig", "abgebrochen"].includes(phaseOf(current))) return fail(409, TEXT.exists, "existiert");
        if (registered.has(kennung) || taken(kennung)) return fail(409, TEXT.taken, "vergeben");
        const d: Draft = {
          kennung,
          revision: 1,
          ...(typeof b.satz === "string" && b.satz.trim() ? { satz: b.satz.trim() } : {}),
          schritt: (b.schritt as number) ?? 1,
          felder: checked.felder,
          ...(offen ? { offen } : {}),
          anhaenge: [],
          erstelltAm: at,
          geaendertAm: at,
          gebautAm: null,
          verworfen: false,
        };
        drafts.set(kennung, d);
        return ok(view(d), 201);
      }
      const d = editable(kennung);
      if (isResult(d)) return d;
      if (d.revision !== b.revision) return fail(409, TEXT.stale, "veraltet", { revision: d.revision });
      d.felder = checked.felder;
      d.offen = offen;
      if (typeof b.satz === "string") d.satz = b.satz.trim() || undefined;
      if (typeof b.schritt === "number") d.schritt = b.schritt;
      touch(d);
      return ok(view(d));
    },
    async remove(kennung) {
      const d = editable(kennung);
      if (isResult(d)) return d;
      d.verworfen = true;
      drafts.delete(kennung);
      return ok({ ok: true });
    },
    async rename(kennung, body) {
      const b = (body ?? {}) as { revision?: unknown; kennung?: unknown };
      if (typeof b.revision !== "number" || typeof b.kennung !== "string" || Object.keys(b).length !== 2) return fail(400, TEXT.shape, "ungueltig", { fehler: ["Erwartet { revision, kennung }"] });
      const target = b.kennung;
      if (!KENNUNG.test(target) || RESERVED.includes(target) || target.length > 64) return fail(422, TEXT.badKennung, "kennung");
      const d = editable(kennung);
      if (isResult(d)) return d;
      if (d.revision !== b.revision) return fail(409, TEXT.stale, "veraltet", { revision: d.revision });
      if (target === kennung) return ok(view(d));
      const current = drafts.get(target);
      if (current && !current.verworfen && !["fertig", "abgebrochen"].includes(phaseOf(current))) return fail(409, TEXT.exists, "existiert");
      if (registered.has(target) || taken(target)) return fail(409, TEXT.taken, "vergeben");
      // Felder, Satz, Schritt und Anhänge ziehen mit um
      drafts.delete(kennung);
      d.kennung = target;
      touch(d);
      drafts.set(target, d);
      return ok(view(d));
    },
    async build(kennung, body) {
      const d = editable(kennung);
      if (isResult(d)) return d;
      const revision = (body as { revision?: unknown } | null)?.revision;
      if (typeof revision !== "number" || Object.keys(body as object).length !== 1) return fail(422, TEXT.buildOnly, "nur_revision");
      if (d.revision !== revision) return fail(409, TEXT.stale, "veraltet", { revision: d.revision });
      const f = d.felder;
      const fehler: string[] = [];
      if (!f.vorlage) fehler.push("vorlage: Pflicht zum Bauen");
      if (!f.name) fehler.push("name: Pflicht zum Bauen");
      if (!f.zweck) fehler.push("zweck: Pflicht zum Bauen");
      if (f.vorlage === "experte" && f.zugang?.telefon?.anrufer === "alle") fehler.push("zugang.telefon.anrufer: Ein Experte nimmt nur freigegebene Anrufer an, bei allen Anrufern hätte er kein Wissen");
      // Wie openForBuild: Unfertige Eingaben verhindern das Bauen
      if (d.offen?.telefon) fehler.push("zugang.telefon.nummer: ungültige Kennung der Nummer");
      if (f.vorlage === "experte" && d.offen?.links?.some((l) => l.trim() && !/^https:\/\/[^\s@]+$/.test(l.trim()))) fehler.push("links: nur https-Adressen ohne Zugangsdaten");
      if (fehler.length) return fail(422, TEXT.incomplete, "unvollstaendig", { fehler });
      d.gebautAm = now();
      d.geaendertAm = new Date(now()).toISOString();
      return ok({ ok: true, entwurf: `demo-${kennung}`, phase: "job", text: "Der Entwurf wird gebaut. Stimmwahl und Freigabe kommen als Rückfrage in den Direktchat." }, 202);
    },
    async progress(kennung) {
      const d = drafts.get(kennung);
      if (!d || d.verworfen) return fail(404, TEXT.unknown, "unbekannt");
      const phase = phaseOf(d);
      const after = !["wizard", "job"].includes(phase);
      const t = tests(d, phase);
      return ok({
        kennung,
        phase,
        phaseText: PHASE_TEXT[phase],
        versuch: 1,
        ...(phase === "abgebrochen" ? { grund: "Pruefung zweimal gescheitert", fehler: ["tests: mindestens 2 Tests"] } : {}),
        rueckfrageOffen: Boolean(QUESTION[phase]),
        ...(QUESTION[phase] ? { rueckfrage: QUESTION[phase] } : {}),
        ...(after && phase !== "abgebrochen" && phase !== "stimme" && phase !== "freigabe" ? { version: 1 } : {}),
        freigeschaltet: phase === "fertig",
        web: ["anlegen", "fertig", "durchgefallen", "unterbrochen"].includes(phase) && Boolean(d.felder.zugang?.web),
        ...(t ? { tests: t } : {}),
      });
    },
    async addAttachment(kennung, name, bytes) {
      if (!bytes.byteLength) return fail(400, TEXT.empty, "leer");
      const lower = (name ?? "").toLowerCase();
      const pdf = new TextDecoder("latin1").decode(bytes.subarray(0, 5)) === "%PDF-";
      if (!pdf && !/\.(txt|md|markdown)$/.test(lower)) return fail(415, TEXT.attachmentType, "anhang_typ");
      const d = editable(kennung);
      if (isResult(d)) return d;
      if (d.anhaenge.length >= 5) return fail(409, TEXT.attachmentCount, "anhang_zahl");
      const ext = pdf ? "pdf" : lower.endsWith(".txt") ? "txt" : "md";
      const anhang = { datei: `a${(++attachmentCounter).toString(16).padStart(8, "0")}.${ext}`, name: (name ?? `datei.${ext}`).slice(0, 120), mime: pdf ? "application/pdf" : ext === "txt" ? "text/plain" : "text/markdown", bytes: bytes.byteLength };
      d.anhaenge.push(anhang);
      touch(d);
      return ok({ anhang, revision: d.revision }, 201);
    },
    async removeAttachment(kennung, datei) {
      const d = editable(kennung);
      if (isResult(d)) return d;
      if (!d.anhaenge.some((a) => a.datei === datei)) return fail(404, TEXT.attachmentUnknown, "anhang_unbekannt");
      d.anhaenge = d.anhaenge.filter((a) => a.datei !== datei);
      touch(d);
      return ok({ ok: true, revision: d.revision });
    },
    async voices() {
      return ok({ standard: { standard: true, name: "Standardstimme" }, konto: VOICES });
    },
    async probe(body) {
      const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      const keys = b ? Object.keys(b) : [];
      const standard = b?.standard === true && b.voiceId === undefined;
      const voice = typeof b?.voiceId === "string" && b.standard === undefined;
      if (!b || keys.some((k) => !["voiceId", "standard", "sprache"].includes(k)) || (!standard && !voice)) return fail(400, TEXT.probeShape, "ungueltig");
      if (voice && !VOICES.some((v) => v.voiceId === b.voiceId)) return fail(422, TEXT.probeUnknownVoice, "unbekannte_stimme");
      const at = now();
      while (probes.length && probes[0]! <= at - 10 * 60_000) probes.shift();
      if (probes.length >= 10) return { ...fail(429, TEXT.probeTooMany, "zu_viele"), headers: { "Retry-After": String(Math.max(1, Math.ceil((probes[0]! + 10 * 60_000 - at) / 1000))) } };
      probes.push(at);
      if (b.voiceId === PROBE_FAILS) return fail(502, TEXT.probeFailed, "fehlgeschlagen");
      return { status: 200, body: {}, audio: { bytes: demoProbeWav(), type: "audio/wav" } };
    },
  };
}
