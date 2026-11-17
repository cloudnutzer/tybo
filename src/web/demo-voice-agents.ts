/**
 * Attrappen für web:dev (Issue #495): Verwaltung der Sprachagenten und
 * Gesprächsroute ohne Anbieter, ohne Dateien und ohne src/lib. Zwei
 * Beispielagenten im Speicher (einer mit Web-Zugang und Freischaltung, einer
 * nur am Telefon) und ein beschädigtes Rezept. „Testen“ endet nach kurzer
 * Zeit mit einem festen Ergebnis, „Löschen“ entfernt nur aus dem Speicher.
 * Die Gesprächsroute gibt ein Token aus, das nur die SDK-Attrappe
 * (./demo-voice-sdk.ts) annimmt; das Ende bestätigt sie sofort.
 */
import type { VoiceAgentAdminPort, VoiceAgentAdminResult } from "./voice-agent-admin";
import { VOICE_AGENT_ADMIN_TEXT as TEXT } from "./voice-agent-admin";
import type { VoiceAgentSessionPort, VoiceAgentSessionResult } from "./voice-agent-page";

interface DemoAgent {
  kennung: string;
  name: string;
  vorlage: string;
  gedaechtnis: string;
  gehirn: string;
  web: boolean;
  telefon: boolean;
  angelegt: boolean;
  freigeschaltet: boolean;
  minutenMonat: number;
  maxMinuten: number;
  verbraucht: number;
  letzterTest: Record<string, unknown> | null;
  fruehereTests: Record<string, unknown>[];
  laufenderTest: { gestartetAm: string; verfolgt: boolean } | null;
  rezept: { titel: string; zeilen: { feld: string; wert: string }[] }[];
  versionen: number[];
}

function sections(name: string, kennung: string, zweck: string, web: boolean, telefon: boolean, minuten: number) {
  return [
    {
      titel: "Allgemein",
      zeilen: [
        { feld: "Name", wert: name },
        { feld: "Kennung", wert: kennung },
        { feld: "Zweck", wert: zweck },
      ],
    },
    {
      titel: "Persona",
      zeilen: [
        { feld: "Rolle", wert: "Ruhiger Assistent" },
        { feld: "Anrede", wert: "du" },
        { feld: "Erster Satz", wert: "Was liegt an?" },
      ],
    },
    {
      titel: "Zugang und Grenzen",
      zeilen: [
        { feld: "Im Browser", wert: web ? "ja, nach Anmeldung in der WebUI" : "nein" },
        { feld: "Telefon", wert: telefon ? "Nummer beim Anbieter phnum_beispiel, Anrufer: alle, PIN: nein" : "nein" },
        { feld: "Minuten im Monat", wert: String(minuten) },
      ],
    },
    {
      titel: "Tests",
      zeilen: [
        { feld: "Begrüßung", wert: "Jemand ruft an. Erwartet: grüßt freundlich. Höchstens 4 Züge." },
        { feld: "Drängeln", wert: "Jemand drängelt. Erwartet: bleibt ruhig. Höchstens 6 Züge." },
      ],
    },
  ];
}

function seed(now: () => number): DemoAgent[] {
  const yesterday = new Date(now() - 86_400_000).toISOString();
  return [
    {
      kennung: "jarvis",
      name: "Jarvis",
      vorlage: "jarvis",
      gedaechtnis: "voll",
      gehirn: "bruecke",
      web: true,
      telefon: false,
      angelegt: true,
      freigeschaltet: true,
      minutenMonat: 300,
      maxMinuten: 12,
      verbraucht: 14,
      letzterTest: {
        gestartetAm: yesterday,
        beendetAm: yesterday,
        ergebnis: "bestanden",
        tests: [
          { name: "Begrüßung", status: "bestanden" },
          { name: "Drängeln", status: "bestanden" },
        ],
      },
      fruehereTests: [],
      laufenderTest: null,
      rezept: sections("Jarvis", "jarvis", "Hilft im Alltag.", true, false, 300),
      versionen: [1, 2],
    },
    {
      kennung: "empfang",
      name: "Empfang",
      vorlage: "anrufannahme",
      gedaechtnis: "thema",
      gehirn: "anbieter",
      web: false,
      telefon: true,
      angelegt: true,
      freigeschaltet: false,
      minutenMonat: 120,
      maxMinuten: 5,
      verbraucht: 0,
      letzterTest: {
        gestartetAm: yesterday,
        beendetAm: yesterday,
        ergebnis: "durchgefallen",
        tests: [
          { name: "Begrüßung", status: "bestanden" },
          { name: "Drängeln", status: "durchgefallen", kriterium: "bleibt ruhig" },
        ],
      },
      fruehereTests: [],
      laufenderTest: null,
      rezept: sections("Empfang", "empfang", "Nimmt Anrufe an und notiert Rückrufe.", false, true, 120),
      versionen: [1],
    },
  ];
}

export interface DemoVoiceAgents {
  admin: VoiceAgentAdminPort;
  sessions: VoiceAgentSessionPort;
  /** Fertiger Agent aus der Wizard-Attrappe (Issue #515): angelegt, getestet, freigeschaltet */
  register(agent: { kennung: string; name: string; vorlage: string; zweck: string; web: boolean; telefon: boolean }): void;
  /** Gibt es einen Agenten mit dieser Kennung? Der Wizard meldet sie dann als vergeben */
  has(kennung: string): boolean;
}

export function createDemoVoiceAgents(options: { now?: () => number; testMs?: number; origin?: () => string } = {}): DemoVoiceAgents {
  const now = options.now ?? (() => Date.now());
  const testMs = options.testMs ?? 3_000;
  const agents = seed(now);
  const broken = [{ datei: "alt.json", fehler: ["persona.ersterSatz fehlt"] }];
  const calls = new Map<string, string>();
  let counter = 0;
  const find = (kennung: string) => agents.find((a) => a.kennung === kennung);
  const notFound = (): VoiceAgentAdminResult => ({ status: 404, body: { error: TEXT.unknown, reason: "unbekannt" } });

  const entry = (a: DemoAgent) => ({
    kennung: a.kennung,
    name: a.name,
    vorlage: a.vorlage,
    gedaechtnis: a.gedaechtnis,
    gehirn: a.gehirn,
    web: a.web,
    telefon: a.telefon,
    angelegt: a.angelegt,
    letzterTest: a.letzterTest,
    laufenderTest: a.laufenderTest,
    minutenMonat: a.minutenMonat,
  });

  const admin: VoiceAgentAdminPort = {
    async list() {
      return { status: 200, body: { agents: agents.map(entry), kaputt: broken } };
    },
    async detail(kennung, version) {
      const a = find(kennung);
      if (!a) return kennung === "alt" ? { status: 422, body: { error: TEXT.broken, reason: "kaputt" } } : notFound();
      if (version !== null && !a.versionen.includes(version)) return { status: 404, body: { error: TEXT.noVersion, reason: "keine_version" } };
      const latest = a.versionen[a.versionen.length - 1];
      return {
        status: 200,
        body: {
          ...entry(a),
          fruehereTests: a.fruehereTests,
          rezept: a.rezept,
          version,
          versionen: [...a.versionen].reverse().map((v) => ({ version: v, aktuell: v === latest, lesbar: true })),
          maxMinuten: a.maxMinuten,
          minutenWeb: a.web ? { limit: a.minutenMonat, verbraucht: a.verbraucht } : null,
        },
      };
    },
    async test(kennung) {
      const a = find(kennung);
      if (!a) return notFound();
      if (a.laufenderTest) return { status: 409, body: { error: TEXT.testRunning, reason: "laeuft", seit: a.laufenderTest.gestartetAm } };
      const gestartetAm = new Date(now()).toISOString();
      a.laufenderTest = { gestartetAm, verfolgt: true };
      setTimeout(() => {
        a.laufenderTest = null;
        if (a.letzterTest) a.fruehereTests = [a.letzterTest, ...a.fruehereTests].slice(0, 4);
        a.letzterTest = {
          gestartetAm,
          beendetAm: new Date(now()).toISOString(),
          ergebnis: "bestanden",
          tests: [
            { name: "Begrüßung", status: "bestanden" },
            { name: "Drängeln", status: "bestanden" },
          ],
        };
      }, testMs);
      return { status: 202, body: { ok: true, text: TEXT.testStarted } };
    },
    async link(kennung) {
      const a = find(kennung);
      if (!a) return notFound();
      if (!a.web) return { status: 409, body: { error: TEXT.noWeb, reason: "kein_web" } };
      if (!a.freigeschaltet) return { status: 409, body: { error: TEXT.locked, reason: "gesperrt" } };
      const base = options.origin?.() ?? "http://127.0.0.1:3199";
      return { status: 200, body: { url: `${base}/sa/${kennung}` } };
    },
    async remove(kennung) {
      const index = agents.findIndex((a) => a.kennung === kennung);
      if (index < 0) return notFound();
      agents.splice(index, 1);
      return { status: 200, body: { ok: true, archiv: `data/voice-agents/${kennung}/geloescht/beispiel.json` } };
    },
  };

  const info = (a: DemoAgent): VoiceAgentSessionResult => ({
    status: 200,
    body: {
      kennung: a.kennung,
      name: a.name,
      bereit: a.web && a.freigeschaltet && !calls.has(a.kennung),
      ...(a.web && a.freigeschaltet ? {} : { grund: a.web ? TEXT.locked : TEXT.noWeb }),
      laufend: null,
      maxMinuten: a.maxMinuten,
      minuten: { limit: a.minutenMonat, verbraucht: a.verbraucht },
    },
  });

  const sessions: VoiceAgentSessionPort = {
    async page(kennung) {
      const a = find(kennung);
      if (!a) return "unbekannt";
      return a.web ? "ok" : "kein_web";
    },
    async info(kennung) {
      const a = find(kennung);
      return a ? info(a) : { status: 404, body: { error: TEXT.unknown, reason: "unbekannt" } };
    },
    async start(kennung) {
      const a = find(kennung);
      if (!a || !a.web) return { status: 404, body: { error: TEXT.unknown, reason: "unbekannt" } };
      if (calls.has(kennung)) return { status: 409, body: { error: "Läuft schon.", reason: "laeuft" } };
      counter++;
      const id = `conv_demo_${counter}`;
      calls.set(kennung, id);
      return { status: 200, body: { conversationToken: `demo-token-${counter}`, conversationId: id } };
    },
    async end(kennung, body) {
      let id: unknown = null;
      try {
        id = JSON.parse(body)?.conversationId;
      } catch {
        // unten
      }
      const a = find(kennung);
      if (!a || calls.get(kennung) !== id) return { status: 404, body: { error: "Es läuft kein Gespräch, das sich beenden ließe.", reason: "kein_gespraech" } };
      calls.delete(kennung);
      a.verbraucht += 1;
      return { status: 200, body: { ok: true, minuten: 1 } };
    },
  };

  function register(agent: { kennung: string; name: string; vorlage: string; zweck: string; web: boolean; telefon: boolean }): void {
    if (find(agent.kennung)) return;
    const at = new Date(now()).toISOString();
    agents.push({
      kennung: agent.kennung,
      name: agent.name,
      vorlage: agent.vorlage,
      gedaechtnis: agent.vorlage === "experte" ? "thema" : agent.vorlage === "jarvis" ? "voll" : "keins",
      gehirn: agent.vorlage === "jarvis" ? "bruecke" : "anbieter",
      web: agent.web,
      telefon: agent.telefon,
      angelegt: true,
      freigeschaltet: true,
      minutenMonat: 300,
      maxMinuten: 10,
      verbraucht: 0,
      letzterTest: { gestartetAm: at, beendetAm: at, ergebnis: "bestanden", tests: [{ name: "Notfall", status: "bestanden" }] },
      fruehereTests: [],
      laufenderTest: null,
      rezept: sections(agent.name, agent.kennung, agent.zweck, agent.web, agent.telefon, 300),
      versionen: [1],
    });
  }

  return { admin, sessions, register, has: (kennung) => Boolean(find(kennung)) };
}
