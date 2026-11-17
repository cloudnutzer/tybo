/**
 * Issue #515, Checkbox 3: Zustand des Wizards (sprachagent-wizard-state.js)
 * ohne Browser. Weiter und Zurück, Pflichtfelder je Vorlage, Vorlagenwechsel,
 * verspätete Vorschläge, Speicherreihenfolge mit revision, 409 „veraltet“ und
 * kein PUT nach dem Bauen. Die Server-Attrappe ist eine Fetch-Hülle mit
 * revision wie wizard-store.ts; ein Test läuft gegen die echte Attrappe aus
 * web:dev (demo-voice-agent-wizard.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDemoVoiceAgentWizard } from "../src/web/demo-voice-agent-wizard";

const PUBLIC = resolve(import.meta.dir, "..", "src", "web", "public");
const SOURCE = await readFile(join(PUBLIC, "sprachagent-wizard-state.js"), "utf8");
const w = new Function(
  `${SOURCE}\nreturn { VA_WIZARD_STEPS, VA_WIZARD_TEXT, vaWizardMissing, vaWizardNext, vaWizardBack, vaWizardReadOnly, vaWizardResumeStep, vaWizardSwitchTemplate, vaWizardMergeProposal, vaWizardSendFields, vaWizardFromServer, vaWizardSummary, vaWizardTests, vaWizardCanTalk, vaWizardQuestionText, vaWizardSaver, vaWizardKennungProblem, vaWizardSlug, vaWizardSet, vaWizardGet, vaWizardCostText, vaWizardCreate, vaWizardPlainErrors, vaWizardRoute, vaWizardHash, vaWizardCanOpen, vaWizardDefaultVoice, vaWizardProbeBody, vaWizardDraftMeta, vaWizardFixedFor, vaWizardPinFixed, vaWizardCostNotes, vaWizardOpenInputs, vaWizardWithOpen, vaWizardFromView, vaWizardPutBody };`,
)() as any;

const expert = () => ({ vorlage: "experte", name: "Trainer", zweck: "Üben", training: { kriterien: ["eins", "zwei", "drei"] } });

describe("Schritte und Pflichtfelder", () => {
  test("Schritt 1 verlangt Vorlage, Name, Zweck und eine gültige Kennung; Weiter bleibt sonst stehen", () => {
    const state = { schritt: 1, kennung: "", felder: {} };
    const next = w.vaWizardNext(state);
    expect(next.schritt).toBe(1);
    expect(next.fehlt.map((f: any) => f.feld)).toEqual(["vorlage", "name", "zweck", "kennung"]);
    expect(w.vaWizardNext({ schritt: 1, kennung: "trainer", felder: expert() })).toEqual({ schritt: 2, fehlt: [] });
    expect(w.vaWizardKennungProblem("stimmen")).toContain("reserviert");
    expect(w.vaWizardKennungProblem("Mit Leerzeichen")).toContain("Kleinbuchstaben");
    expect(w.vaWizardSlug("Küchen Hilfe!")).toBe("kuechen-hilfe");
  });

  test("Experte braucht genau drei Kriterien, leere zählen nicht", () => {
    const two = { schritt: 3, kennung: "t", felder: { ...expert(), training: { kriterien: ["a", "b", " "] } } };
    expect(w.vaWizardNext(two).fehlt[0].feld).toBe("training.kriterien");
    expect(w.vaWizardNext({ schritt: 3, kennung: "t", felder: expert() }).schritt).toBe(4);
    // Andere Vorlagen brauchen keine Kriterien
    expect(w.vaWizardNext({ schritt: 3, kennung: "t", felder: { vorlage: "jarvis", name: "J", zweck: "Z" } }).schritt).toBe(4);
  });

  test("Schritt 4: Telefon braucht die Kennung der Nummer; Experte nicht mit allen Anrufern", () => {
    const state = (telefon: any, vorlage = "jarvis") => ({ schritt: 4, kennung: "t", felder: { vorlage, name: "N", zweck: "Z", zugang: { telefon } } });
    expect(w.vaWizardNext(state({ nummer: "", anrufer: "freigegeben" })).fehlt[0].feld).toBe("zugang.telefon.nummer");
    expect(w.vaWizardNext(state({ nummer: "+49 30 123", anrufer: "freigegeben" })).fehlt[0].feld).toBe("zugang.telefon.nummer");
    expect(w.vaWizardNext(state({ nummer: "phnum_1", anrufer: "freigegeben" })).schritt).toBe(5);
    expect(w.vaWizardNext(state({ nummer: "phnum_1", anrufer: "alle" }, "experte")).fehlt.map((f: any) => f.feld)).toContain("zugang.telefon.anrufer");
  });

  test("Schritt 5 prüft alles, was zum Bauen nötig ist", () => {
    expect(w.vaWizardMissing({ schritt: 5, kennung: "t", felder: { vorlage: "experte", name: "N" } }, 5).map((f: any) => f.feld)).toEqual(["zweck", "training.kriterien"]);
  });

  test("Zurück geht immer, nie unter Schritt 1; nach dem Bauen nur ansehen", () => {
    expect(w.vaWizardBack({ schritt: 3 })).toEqual({ schritt: 2 });
    expect(w.vaWizardBack({ schritt: 1 })).toEqual({ schritt: 1 });
    expect(w.vaWizardReadOnly({ phase: "wizard" })).toBe(false);
    expect(w.vaWizardReadOnly({ phase: "job" })).toBe(true);
    expect(w.vaWizardResumeStep({ phase: "wizard", schritt: 3 })).toBe(3);
    expect(w.vaWizardResumeStep({ phase: "freigabe", schritt: 3 })).toBe(5);
    expect(w.vaWizardResumeStep({ phase: "wizard" })).toBe(1);
  });
});

describe("Vorlagenwechsel und Felder zum Senden", () => {
  test("Experte mit Kriterien, Anrufannahme, zurück: Kriterien bleiben, Gedächtnis geht nie mit", () => {
    let f: any = { ...expert(), gedaechtnis: "thema" };
    f = w.vaWizardSwitchTemplate(f, "anrufannahme");
    expect(f.training.kriterien).toEqual(["eins", "zwei", "drei"]);
    expect(f.gedaechtnis).toBeUndefined();
    f = { ...f, gedaechtnis: "keins" };
    f = w.vaWizardSwitchTemplate(f, "experte");
    expect(f.training.kriterien).toEqual(["eins", "zwei", "drei"]);
    expect(w.vaWizardSendFields(f).gedaechtnis).toBeUndefined();
  });

  test("Senden: eigene Regeln ohne feste, leere Einträge weg, KI-Hinweis nie", () => {
    const view = { regeln: [{ text: "Notfall: 112", fest: true }, { text: "Sei knapp", fest: false }], persona: { kiHinweis: "Hallo, KI", rolle: " " }, training: { kriterien: ["a", "", "c"] }, anrufannahme: { fragen: ["Name", " "], abschlusssatz: "" } };
    const out = w.vaWizardSendFields(w.vaWizardFromServer(view));
    // Ohne die festen Regeln der Vorlage nur die eigenen; mit ihnen beide, die festen gekennzeichnet
    expect(out.regeln).toEqual(["Sei knapp"]);
    const fixed = { basis: ["Notfall: 112"], experte: ["Notfall: 112", "Wissen: nichts erfinden"], anrufannahme: ["Notfall: 112", "Privates: nichts"] };
    const own = { vorlage: "experte", regeln: ["Sei knapp", " ", "Notfall: 112"] };
    expect(w.vaWizardSendFields(own, fixed).regeln).toEqual([{ text: "Notfall: 112", fest: true }, { text: "Wissen: nichts erfinden", fest: true }, "Sei knapp"]);
    // Nach einem Vorlagenwechsel die festen der neuen Vorlage
    expect(w.vaWizardSendFields(w.vaWizardSwitchTemplate(own, "anrufannahme"), fixed).regeln).toEqual([{ text: "Notfall: 112", fest: true }, { text: "Privates: nichts", fest: true }, "Sei knapp"]);
    expect(w.vaWizardSendFields({ regeln: ["Sei knapp"] }, fixed).regeln).toEqual([{ text: "Notfall: 112", fest: true }, "Sei knapp"]);
    // Ohne eigene Regeln fehlt das Feld: Der Server setzt die festen selbst
    expect(w.vaWizardSendFields({ vorlage: "experte", regeln: [" "] }, fixed).regeln).toBeUndefined();
    expect(out.persona).toBeUndefined();
    expect(out.training.kriterien).toEqual(["a", "c"]);
    expect(out.anrufannahme).toEqual({ fragen: ["Name"] });
  });
});

describe("Zwischenstände, die der Server ablehnen würde, bleiben auf der Seite", () => {
  test("Telefon ohne gültige Kennung der Nummer geht nicht mit, mit ihr schon", () => {
    const base = { vorlage: "jarvis", zugang: { web: true, telefon: { nummer: "", anrufer: "freigegeben", pin: false } } };
    expect(w.vaWizardSendFields(base).zugang).toEqual({ web: true });
    expect(w.vaWizardSendFields(w.vaWizardSet(base, "zugang.telefon.nummer", "mit leer")).zugang).toEqual({ web: true });
    expect(w.vaWizardSendFields(w.vaWizardSet(base, "zugang.telefon.nummer", "nr_1")).zugang.telefon).toEqual({ nummer: "nr_1", anrufer: "freigegeben", pin: false });
    // Die Seite behält die Eingabe
    expect(base.zugang.telefon.nummer).toBe("");
  });

  test("halb getippte oder unsichere Links gehen nicht mit; Weiter in Schritt 3 nennt sie", () => {
    const felder = { ...expert(), links: ["https://example.org/a", "https://", "http://example.org", "https://nutzer:pw@example.org", " "] };
    expect(w.vaWizardSendFields(felder).links).toEqual(["https://example.org/a"]);
    expect(w.vaWizardMissing({ schritt: 3, kennung: "t", felder }, 3).map((m: any) => m.feld)).toEqual(["links"]);
    expect(w.vaWizardMissing({ schritt: 3, kennung: "t", felder: { ...expert(), links: ["https://example.org/a", ""] } }, 3)).toEqual([]);
    // Bei anderen Vorlagen bleiben gespeicherte Links unbeachtet
    expect(w.vaWizardMissing({ schritt: 3, kennung: "t", felder: { vorlage: "jarvis", name: "J", zweck: "Z", links: ["kaputt"] } }, 3)).toEqual([]);
  });
});

describe("Vorschlag", () => {
  const proposal = { kennung: "verhandlungstrainer", felder: { vorlage: "experte", name: "Verhandlungstrainer", zweck: "Üben", regeln: [{ text: "Notfall", fest: true }], training: { kriterien: ["x", "y", "z"] } } };

  test("füllt leere, unberührte Felder und die Kennung", () => {
    const r = w.vaWizardMergeProposal({ kennung: "", felder: {} }, proposal, []);
    expect(r.dropped).toBe(false);
    expect(r.kennung).toBe("verhandlungstrainer");
    expect(r.felder).toMatchObject({ vorlage: "experte", name: "Verhandlungstrainer", training: { kriterien: ["x", "y", "z"] } });
    expect(r.felder.regeln).toBeUndefined();
  });

  test("verspätet: überschreibt keine geänderten Felder, Hinweis „Vorschlag verworfen“", () => {
    const state = { kennung: "mein-name", felder: { name: "Mein Name", vorlage: "jarvis" } };
    const r = w.vaWizardMergeProposal(state, proposal, ["name", "vorlage", "kennung"]);
    expect(r.dropped).toBe(true);
    expect(r.felder.name).toBe("Mein Name");
    expect(r.felder.vorlage).toBe("jarvis");
    expect(r.kennung).toBe("mein-name");
    // Leere Felder füllt er trotzdem
    expect(r.felder.zweck).toBe("Üben");
    expect(w.VA_WIZARD_TEXT.proposalDropped).toBe("Vorschlag verworfen, Ihre Eingaben bleiben.");
  });

  test("ein angefasstes, wieder geleertes Feld bleibt leer", () => {
    const r = w.vaWizardMergeProposal({ kennung: "", felder: {} }, proposal, ["zweck"]);
    expect(r.felder.zweck).toBeUndefined();
    expect(r.dropped).toBe(true);
  });

  test("Kennung steht nach dem Anlegen fest", () => {
    const r = w.vaWizardMergeProposal({ kennung: "", kennungFest: true, felder: {} }, proposal, []);
    expect(r.kennung).toBe("");
  });
});

describe("Zusammenfassung und Fortschritt", () => {
  const view = {
    kennung: "empfang",
    felder: {
      vorlage: "anrufannahme",
      name: "Empfang",
      zweck: "Nimmt an",
      persona: { sprachen: ["de"], anrede: "sie", kiHinweis: "Hallo, hier spricht eine KI." },
      regeln: [{ text: "Notfall: 112", fest: true }],
      gedaechtnis: "keins",
      stimme: { wahl: "konto", voiceId: "v1", name: "Mia" },
      anrufannahme: { fragen: ["Name"], abschlusssatz: "Danke." },
      zugang: { web: true, telefon: { nummer: "phnum_1", anrufer: "alle", pin: false }, maxMinuten: 5 },
      training: { kriterien: ["a", "b", "c"] },
    },
    feste: [
      { feld: "persona.kiHinweis", wert: "Hallo, hier spricht eine KI.", fest: true, grund: "KI-Hinweis als erster Satz jedes Gesprächs" },
      { feld: "gedaechtnis", wert: "keins", fest: true, grund: "Die Anrufannahme spricht mit Fremden und hat kein Gedächtnis" },
    ],
    kosten: { status: "ok", waehrung: "USD", jeMinute: 0.1, jeGespraech: 0.5, credits: { jeMinute: 550, jeGespraech: 2750, tarif: "Creator" } },
    anhaenge: [],
  };

  test("nur Klartext: kein JSON, keine Feldnamen, keine geschweiften Klammern", () => {
    const sections = w.vaWizardSummary(view, { konto: [{ voiceId: "v1", name: "Mia" }] });
    const text = JSON.stringify(sections.map((s: any) => [s.titel, ...s.zeilen.map((z: any) => `${z.feld}: ${z.wert}`)]));
    const plain = sections.flatMap((s: any) => [s.titel, ...s.zeilen.flatMap((z: any) => [z.feld, z.wert])]).join("\n");
    for (const bad of ["persona.regeln", "persona.kiHinweis", "zugang.telefon", "gedaechtnis", "anrufannahme.fragen", "{", "}", "[object", "undefined", "null"]) expect(plain).not.toContain(bad);
    expect(plain).toContain("Fragen an den Anrufer");
    expect(plain).toContain("Abschlusssatz");
    expect(plain).toContain("Mia (Stimme Ihres Kontos beim Anbieter)");
    expect(plain).toContain("kein Gedächtnis");
    // Kriterien des Experten erscheinen bei der Anrufannahme nicht
    expect(plain).not.toContain("Kriterien");
    expect(text.length).toBeGreaterThan(0);
  });

  test("Hinweise zu den Kosten ohne Feldnamen", () => {
    expect(w.vaWizardCostNotes({ hinweise: ["Im Plan enthaltene Minuten sind nicht abgezogen", "Ohne maxMinuten keine Schätzung je Gespräch"] })).toEqual(["Im Plan enthaltene Minuten sind nicht abgezogen", "Ohne Höchstdauer je Gespräch gibt es keine Schätzung je Gespräch"]);
    expect(w.vaWizardCostNotes(null)).toEqual([]);
  });

  test("Kosten in einem Satz", () => {
    expect(w.vaWizardCostText(view.kosten)).toBe("etwa 0,10 USD je Minute, höchstens 0,50 USD je Gespräch, 550 Credits je Minute");
    expect(w.vaWizardCostText({ status: "unbekannt" })).toBe("nicht bekannt");
  });

  test("Testergebnisse je Test, durchgefallene mit Grund; Sprechen nur mit Freischaltung und Web", () => {
    const p = { phase: "durchgefallen", rueckfrage: "freischalten", freigeschaltet: false, web: true, tests: { status: "durchgefallen", liste: [{ name: "Notfall", status: "bestanden" }, { name: "Hinweis", status: "durchgefallen", grund: "Zu spät." }] } };
    expect(w.vaWizardTests(p)).toEqual({ satz: "Mindestens ein Test ist durchgefallen.", zeilen: [{ name: "Notfall", status: "bestanden" }, { name: "Hinweis", status: "durchgefallen", grund: "Zu spät." }] });
    expect(w.vaWizardQuestionText(p)).toContain("trotzdem freischalten");
    expect(w.vaWizardCanTalk(p)).toBe(false);
    expect(w.vaWizardCanTalk({ freigeschaltet: true, web: false })).toBe(false);
    expect(w.vaWizardCanTalk({ freigeschaltet: true, web: true })).toBe(true);
    expect(w.vaWizardTests({ phase: "job" })).toBeNull();
  });
});

// --- Speichern mit Fetch-Attrappe -------------------------------------------------

interface Call {
  method: string;
  path: string;
  body?: any;
}

/** Server wie wizard-store.ts: revision steigt mit PUT und Anhängen, veraltete revision 409 */
function fakeServer() {
  const calls: Call[] = [];
  const state = { revision: 1, felder: {} as any, phase: "wizard", inFlight: 0, maxInFlight: 0, hold: null as null | Promise<void> };
  const reply = (status: number, body: any) => ({ status, body });
  async function request(method: string, path: string, body?: any) {
    calls.push({ method, path, body });
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (state.hold) await state.hold;
      await new Promise((r) => setTimeout(r, 1));
      if (method === "GET") return reply(200, { revision: state.revision, felder: state.felder, phase: state.phase });
      if (method === "PUT") {
        if (state.phase !== "wizard") return reply(409, { reason: "gebaut" });
        if (body.revision !== state.revision) return reply(409, { reason: "veraltet", revision: state.revision });
        state.revision++;
        state.felder = body.felder;
        return reply(200, { revision: state.revision, felder: body.felder, phase: state.phase });
      }
      if (method === "DELETE") {
        state.revision++;
        return reply(200, { ok: true, revision: state.revision });
      }
      if (method === "POST" && path.endsWith("/bauen")) {
        if (body.revision !== state.revision) return reply(409, { reason: "veraltet", revision: state.revision });
        state.phase = "job";
        return reply(202, { ok: true });
      }
      return reply(404, {});
    } finally {
      state.inFlight--;
    }
  }
  async function upload(path: string, name: string) {
    calls.push({ method: "UPLOAD", path, body: name });
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      if (state.phase !== "wizard") return reply(409, { reason: "gebaut" });
      state.revision++;
      return reply(201, { revision: state.revision, anhang: { datei: "a00000001.md", name } });
    } finally {
      state.inFlight--;
    }
  }
  return { calls, state, request, upload };
}

/** Seite als Attrappe: Felder, ungespeicherte Pfade, Meldungen */
function page(server: ReturnType<typeof fakeServer>, felder: any = { vorlage: "jarvis", name: "J", zweck: "Z" }) {
  const p = {
    felder,
    dirty: new Set<string>(),
    messages: [] as { text: string; error: boolean }[],
    type(path: string, value: unknown) {
      p.felder = w.vaWizardSet(p.felder, path, value);
      p.dirty.add(path);
      saver.schedule();
    },
  };
  const saver = w.vaWizardSaver({
    kennung: "test",
    revision: server.state.revision,
    request: server.request,
    upload: server.upload,
    fields: () => p.felder,
    dirty: () => [...p.dirty],
    schritt: () => 3,
    debounceMs: 5,
    onSaved: (_view: any, saved: string[], sent: any) => {
      for (const path of saved) if (JSON.stringify(w.vaWizardGet(p.felder, path)) === JSON.stringify(w.vaWizardGet(sent, path))) p.dirty.delete(path);
    },
    onState: (text: string, error: boolean) => p.messages.push({ text, error }),
  });
  return { p, saver };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Speichern", () => {
  test("entprellt: viele Tastendrücke, ein PUT mit allen Eingaben", async () => {
    const server = fakeServer();
    const { p, saver } = page(server);
    for (const c of ["R", "Ro", "Rol", "Rolle"]) p.type("persona.rolle", c);
    await wait(20);
    await saver.idle();
    const puts = server.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ revision: 1, schritt: 3, felder: { persona: { rolle: "Rolle" } } });
    expect(p.dirty.size).toBe(0);
  });

  test("nacheinander, nie parallel; jede Anfrage mit der revision der vorigen", async () => {
    const server = fakeServer();
    const { p, saver } = page(server);
    p.type("name", "A");
    const a = saver.flush();
    p.type("name", "B");
    const b = saver.flush();
    p.type("name", "C");
    await Promise.all([a, b, saver.flush()]);
    await saver.idle();
    expect(server.state.maxInFlight).toBe(1);
    expect(server.calls.filter((c) => c.method === "PUT").map((c) => c.body.revision)).toEqual([1, 2, 3]);
    expect(server.state.felder.name).toBe("C");
    expect(p.messages.some((m) => m.error)).toBe(false);
  });

  test("gleichzeitig tippen und Anhang hochladen: keine Eingabe geht verloren, kein 409", async () => {
    const server = fakeServer();
    const { p, saver } = page(server);
    p.type("thema", "Segeln");
    const uploaded = saver.upload("notizen.md", new Uint8Array([1]));
    p.type("training.kriterien", ["a", "b", "c"]);
    await uploaded;
    await wait(20);
    await saver.idle();
    expect(server.state.maxInFlight).toBe(1);
    const puts = server.calls.filter((c) => c.method === "PUT");
    expect(puts.every((c) => c.body.revision !== undefined)).toBe(true);
    expect(server.calls.some((c) => c.method === "PUT" && c.body.revision === 1)).toBe(false);
    expect(server.state.felder).toMatchObject({ thema: "Segeln", training: { kriterien: ["a", "b", "c"] } });
    expect(saver.revision).toBe(server.state.revision);
    expect(p.messages.some((m) => m.error)).toBe(false);
  });

  test("409 veraltet: neu laden, eigene Eingaben darüber, einmal erneut; gespeichert", async () => {
    const server = fakeServer();
    const { p, saver } = page(server);
    // Anderswo geändert: revision 2 mit einem anderen Feld
    server.state.revision = 2;
    server.state.felder = { vorlage: "jarvis", name: "J", zweck: "Z", persona: { anrede: "sie" } };
    p.type("persona.rolle", "Köchin");
    await saver.flush();
    const puts = server.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.body.revision)).toEqual([1, 2]);
    expect(server.calls.map((c) => c.method)).toEqual(["PUT", "GET", "PUT"]);
    expect(server.state.felder.persona).toEqual({ anrede: "sie", rolle: "Köchin" });
    expect(saver.revision).toBe(3);
    expect(p.dirty.size).toBe(0);
  });

  test("409 auch beim zweiten Versuch: sagt es und verwirft nichts", async () => {
    const server = fakeServer();
    const original = server.request;
    let gets = 0;
    // Jeder GET liefert eine revision, die beim zweiten PUT schon wieder veraltet ist
    (server as any).request = async (method: string, path: string, body?: any) => {
      const r = await original(method, path, body);
      if (method === "GET") {
        gets++;
        server.state.revision++;
      }
      return r;
    };
    const { p, saver } = page(server);
    server.state.revision = 5;
    p.type("name", "Neuer Name");
    const result = await saver.flush();
    expect(result.ok).toBe(false);
    expect(gets).toBe(1);
    expect(server.calls.map((c) => c.method)).toEqual(["PUT", "GET", "PUT"]);
    expect(p.felder.name).toBe("Neuer Name");
    expect(p.dirty.has("name")).toBe(true);
    expect(p.messages.at(-1)).toEqual({ text: w.VA_WIZARD_TEXT.saveStale, error: true });
  });

  test("nach dem Bauen: kein PUT mehr, auch nicht entprellt", async () => {
    const server = fakeServer();
    const { p, saver } = page(server);
    p.type("name", "Fertig");
    const res = await saver.build();
    expect(res.status).toBe(202);
    expect(saver.frozen).toBe(true);
    const before = server.calls.length;
    p.type("name", "Doch anders");
    await wait(20);
    await saver.flush();
    await saver.idle();
    expect(server.calls.length).toBe(before);
    expect(server.calls.filter((c) => c.method === "PUT").map((c) => c.body.felder.name)).toEqual(["Fertig"]);
    // Bauen speichert vorher, dann mit der neuen revision
    expect(server.calls.map((c) => c.method)).toEqual(["PUT", "POST"]);
  });

  test("freeze (Phase nicht mehr „wizard“ beim Laden): weder PUT noch Anhang", async () => {
    const server = fakeServer();
    const { p, saver } = page(server);
    saver.freeze();
    p.type("name", "x");
    await wait(20);
    expect(await saver.upload("a.md", new Uint8Array([1]))).toEqual({ ok: false, reason: "gebaut" });
    expect(await saver.removeAttachment("a00000001.md")).toEqual({ ok: false, reason: "gebaut" });
    expect(server.calls).toEqual([]);
  });

  test("gegen die Attrappe aus web:dev: Anlegen, Speichern, Anhang, Bauen, danach kein PUT", async () => {
    const demo = createDemoVoiceAgentWizard({ stepMs: 60_000 });
    const calls: string[] = [];
    const request = async (method: string, path: string, body?: any) => {
      calls.push(method);
      const kennung = decodeURIComponent(path.split("/")[4]!);
      const r = method === "GET" ? await demo.get(kennung) : method === "PUT" ? await demo.put(kennung, body) : method === "DELETE" ? await demo.removeAttachment(kennung, path.split("/").at(-1)!) : await demo.build(kennung, body);
      return { status: r.status, body: r.body };
    };
    const upload = async (path: string, name: string, bytes: Uint8Array) => {
      calls.push("UPLOAD");
      const r = await demo.addAttachment(decodeURIComponent(path.split("/")[4]!), name, bytes);
      return { status: r.status, body: r.body };
    };
    const created = await demo.put("trainer", { felder: { vorlage: "experte", name: "T", zweck: "Z" } });
    let felder: any = w.vaWizardFromServer(created.body.felder);
    const saver = w.vaWizardSaver({ kennung: "trainer", revision: created.body.revision, request, upload, fields: () => felder, dirty: () => [], schritt: () => 3, debounceMs: 1 });
    felder = w.vaWizardSet(felder, "training.kriterien", ["a", "b", "c"]);
    saver.schedule();
    await saver.upload("notizen.md", new TextEncoder().encode("# Notizen"));
    await wait(10);
    await saver.idle();
    expect(((await demo.get("trainer")).body as any).felder.training.kriterien).toEqual(["a", "b", "c"]);
    expect((await saver.build()).status).toBe(202);
    felder = w.vaWizardSet(felder, "name", "Anders");
    saver.schedule();
    await wait(10);
    await saver.idle();
    expect(calls.filter((c) => c === "PUT").length).toBe(2);
    expect(((await demo.get("trainer")).body as any).felder.name).toBe("T");
  });
});

describe("Adressen, Schritte öffnen, Stimme", () => {
  test("Adressen des Wizards kollidieren mit keiner Kennung eines Agenten", () => {
    expect(w.vaWizardRoute("#/neu")).toEqual({ neu: true });
    expect(w.vaWizardRoute("#/entwurf/segel-trainer")).toEqual({ kennung: "segel-trainer" });
    for (const other of ["", "#", "#neu", "#jarvis", "#/entwurf/", "#/entwurf/Mit Leer", "#/entwurf/a/b", "#/entwurf/../x", "#/gespraech/dm"]) expect(w.vaWizardRoute(other)).toBeNull();
    expect(w.vaWizardHash("")).toBe("#/neu");
    expect(w.vaWizardHash("trainer")).toBe("#/entwurf/trainer");
    // „neu“ ist eine erlaubte Kennung: Die Adresse #/neu gehört dem Wizard, #neu einem Agenten
    expect(w.vaWizardKennungProblem("neu")).toBeNull();
  });

  test("ein Schritt weiter vorn öffnet sich nur, wenn davor nichts fehlt; zurück und nach dem Bauen immer", () => {
    const state = { schritt: 3, kennung: "trainer", felder: { vorlage: "experte", name: "T", zweck: "Z", training: { kriterien: ["a"] } } };
    expect(w.vaWizardCanOpen(state, 1)).toBe(true);
    expect(w.vaWizardCanOpen(state, 3)).toBe(true);
    expect(w.vaWizardCanOpen(state, 4)).toBe(false);
    expect(w.vaWizardCanOpen({ ...state, felder: expert() }, 5)).toBe(true);
    expect(w.vaWizardCanOpen({ ...state, phase: "job" }, 5)).toBe(true);
    expect(w.vaWizardCanOpen(state, 6)).toBe(false);
  });

  test("Standardstimme ist vorausgewählt; eine gewählte Stimme des Kontos bleibt, eine verschwundene nicht", () => {
    const voices = { standard: { standard: true, name: "Standardstimme" }, konto: [{ voiceId: "v-mia", name: "Mia", klon: false }] };
    expect(w.vaWizardDefaultVoice({}, voices)).toEqual({ wahl: "standard" });
    expect(w.vaWizardDefaultVoice({ stimme: { wahl: "konto", voiceId: "v-mia" } }, voices)).toEqual({ wahl: "konto", voiceId: "v-mia" });
    expect(w.vaWizardDefaultVoice({ stimme: { wahl: "konto", voiceId: "weg" } }, voices)).toEqual({ wahl: "standard" });
    expect(w.vaWizardDefaultVoice({}, { standard: null, konto: [] })).toBeUndefined();
    expect(w.vaWizardDefaultVoice({ stimme: { wahl: "standard" } }, { standard: null, konto: [] })).toBeUndefined();
  });

  test("Hörprobe fragt genau die Stimme der Zeile an, mit der ersten Sprache des Agenten, nie mit Text", () => {
    expect(w.vaWizardProbeBody({ voiceId: "v-mia" }, { persona: { sprachen: ["en", "de"] } })).toEqual({ voiceId: "v-mia", sprache: "en" });
    expect(w.vaWizardProbeBody({ standard: true }, {})).toEqual({ standard: true, sprache: "de" });
    expect(w.vaWizardProbeBody({ voiceId: "v-mia" }, { persona: { sprachen: ["Deutsch"] } })).toEqual({ voiceId: "v-mia", sprache: "de" });
  });

  test("feste Regeln stehen im passenden Schritt: KI-Hinweis bei der Stimme, Regeln und Gedächtnis beim Verhalten, PIN beim Zugang", () => {
    const view = {
      felder: { vorlage: "jarvis", gedaechtnis: "voll", zugang: { telefon: { nummer: "nr-1", anrufer: "freigegeben", pin: true } } },
      feste: [
        { feld: "persona.kiHinweis", wert: "Hallo, hier spricht eine KI.", fest: true, grund: "KI-Hinweis als erster Satz jedes Gesprächs" },
        { feld: "regeln", wert: "Notfall: 112", fest: true, grund: "Notfall-Regel 112" },
        { feld: "gedaechtnis", wert: "keins", fest: true, grund: "Die Anrufannahme spricht mit Fremden und hat kein Gedächtnis" },
        { feld: "zugang.telefon.pin", wert: true, fest: true, grund: "Gedächtnis voll am Telefon nur mit PIN" },
      ],
    };
    expect(w.vaWizardFixedFor(view, 2).map((e: any) => e.wert)).toEqual(["Hallo, hier spricht eine KI."]);
    expect(w.vaWizardFixedFor(view, 3).map((e: any) => e.wert)).toEqual(["Notfall: 112", "kein Gedächtnis"]);
    expect(w.vaWizardFixedFor(view, 4).map((e: any) => e.wert)).toEqual(["kein Gedächtnis", "PIN ist Pflicht"]);
    expect(w.vaWizardFixedFor(view, 1)).toEqual([]);
    expect(w.vaWizardPinFixed(view)).toBe(true);
    expect(w.vaWizardPinFixed({ feste: [] })).toBe(false);
  });

  test("Entwurf in der Liste: Vorlage und Phase in Klartext", () => {
    expect(w.vaWizardDraftMeta({ vorlage: "experte", phaseText: "Entwurf, noch nicht gebaut" })).toBe("Experte zum Üben · Entwurf, noch nicht gebaut");
    expect(w.vaWizardDraftMeta({ vorlage: null, phaseText: "Fertig" })).toBe("Vorlage noch offen · Fertig");
  });

  test("Fehler des Servers ohne Feldnamen", () => {
    const plain = w.vaWizardPlainErrors([
      "name: Pflicht zum Bauen",
      "zugang.telefon.anrufer: Ein Experte nimmt nur freigegebene Anrufer an",
      "stimme: Diese Stimme gibt es im Konto beim Anbieter nicht (mehr).",
      "training.kriterien[2]: höchstens 500 Zeichen",
      "persona.regeln: zu lang",
      "Ohne Feld davor",
    ]);
    expect(plain).toEqual([
      "Name: Pflicht zum Bauen",
      "Anrufer: Ein Experte nimmt nur freigegebene Anrufer an",
      "Stimme: Diese Stimme gibt es im Konto beim Anbieter nicht (mehr).",
      "Kriterien: Höchstens 500 Zeichen",
      "Zu lang",
      "Ohne Feld davor",
    ]);
    for (const line of plain) expect(line).not.toMatch(/[a-z]+\.[a-z]+|\[|\{/);
    expect(w.vaWizardPlainErrors(undefined)).toEqual([]);
  });
});

describe("Anlegen und Kennung ändern", () => {
  /** Attrappe aus web:dev als Fetch-Hülle, mit einem Beispielagenten „empfang“ */
  function demoServer() {
    const demo = createDemoVoiceAgentWizard({ stepMs: 60_000, taken: (k) => k === "empfang" });
    const calls: string[] = [];
    const request = async (method: string, path: string, body?: any) => {
      const parts = path.split("/");
      const kennung = decodeURIComponent(parts[4]!);
      calls.push(`${method} ${parts.slice(4).join("/")}`);
      const r =
        method === "GET" ? await demo.get(kennung)
        : method === "PUT" ? await demo.put(kennung, body)
        : method === "DELETE" ? await demo.removeAttachment(kennung, parts.at(-1)!)
        : parts[5] === "umbenennen" ? await demo.rename(kennung, body)
        : await demo.build(kennung, body);
      return { status: r.status, body: r.body as any };
    };
    const upload = async (path: string, name: string, bytes: Uint8Array) => {
      const r = await demo.addAttachment(decodeURIComponent(path.split("/")[4]!), name, bytes);
      return { status: r.status, body: r.body as any };
    };
    return { demo, calls, request, upload };
  }

  test("erstes Speichern legt an und reserviert die Kennung, mit Satz und Schritt", async () => {
    const s = demoServer();
    const created = await w.vaWizardCreate(s.request, "trainer", { satz: "Ein Trainer", schritt: 1, felder: expert() });
    expect(created.ok).toBe(true);
    expect(created.view).toMatchObject({ kennung: "trainer", revision: 1, satz: "Ein Trainer", schritt: 1, phase: "wizard" });
    expect(s.calls).toEqual(["PUT trainer"]);
  });

  test("Kennung beim Anlegen vergeben oder ungültig: Satz des Servers, nichts angelegt, die Eingaben bleiben", async () => {
    const s = demoServer();
    const state = { satz: "Empfang", schritt: 1, felder: expert() };
    const taken = await w.vaWizardCreate(s.request, "empfang", state);
    expect(taken).toMatchObject({ ok: false, reason: "vergeben", kennung: true });
    expect(taken.error).toContain("hat schon ein Sprachagent");
    expect(state.felder).toEqual(expert());
    await w.vaWizardCreate(s.request, "trainer", state);
    expect(await w.vaWizardCreate(s.request, "trainer", state)).toMatchObject({ ok: false, reason: "existiert", kennung: true });
    expect(await w.vaWizardCreate(async () => { throw new Error("Netz weg"); }, "x", state)).toMatchObject({ ok: false, reason: "fehler", error: w.VA_WIZARD_TEXT.createFailed, kennung: false });
  });

  test("Kennung nach dem ersten Speichern ändern: Felder und Anhang ziehen mit, danach speichert und baut der Wizard unter der neuen", async () => {
    const s = demoServer();
    const created = await w.vaWizardCreate(s.request, "segel-alt", { schritt: 1, felder: expert() });
    let felder: any = w.vaWizardFromServer(created.view.felder);
    const renamed: string[] = [];
    const saver = w.vaWizardSaver({ kennung: "segel-alt", revision: created.view.revision, request: s.request, upload: s.upload, fields: () => felder, dirty: () => [], schritt: () => 3, debounceMs: 1, onRenamed: (view: any) => renamed.push(view.kennung) });
    await saver.upload("notizen.md", new TextEncoder().encode("# Notizen"));
    felder = w.vaWizardSet(felder, "thema", "Segeln");
    saver.schedule();
    const r = await saver.rename("segel-neu");
    expect(r).toEqual({ ok: true, kennung: "segel-neu" });
    expect(saver.kennung).toBe("segel-neu");
    expect(renamed).toEqual(["segel-neu"]);
    await wait(10);
    await saver.idle();
    const moved = (await s.demo.get("segel-neu")).body as any;
    expect(moved.felder.thema).toBe("Segeln");
    expect(moved.felder.training.kriterien).toEqual(["eins", "zwei", "drei"]);
    expect(moved.anhaenge).toHaveLength(1);
    expect((await s.demo.get("segel-alt")).status).toBe(404);
    expect((await saver.build()).status).toBe(202);
    expect(((await s.demo.progress("segel-neu")).body as any).phase).toBe("job");
    // Alle Anfragen nach dem Umzug gehen an die neue Kennung
    const after = s.calls.slice(s.calls.indexOf("POST segel-alt/umbenennen") + 1);
    expect(after.every((c) => c.includes("segel-neu"))).toBe(true);
  });

  test("Konflikt beim Ändern: Satz des Servers, der Entwurf bleibt unter der alten Kennung und speichert dort weiter", async () => {
    const s = demoServer();
    const created = await w.vaWizardCreate(s.request, "segel-alt", { schritt: 1, felder: expert() });
    let felder: any = w.vaWizardFromServer(created.view.felder);
    const saver = w.vaWizardSaver({ kennung: "segel-alt", revision: created.view.revision, request: s.request, upload: s.upload, fields: () => felder, dirty: () => [], schritt: () => 1, debounceMs: 1 });
    await saver.upload("notizen.md", new TextEncoder().encode("# Notizen"));
    const r = await saver.rename("empfang");
    expect(r).toMatchObject({ ok: false, reason: "vergeben" });
    expect(r.error).toContain("hat schon ein Sprachagent");
    expect(saver.kennung).toBe("segel-alt");
    felder = w.vaWizardSet(felder, "name", "Segeltrainer");
    expect(await saver.flush()).toEqual({ ok: true });
    const still = (await s.demo.get("segel-alt")).body as any;
    expect(still.felder.name).toBe("Segeltrainer");
    expect(still.anhaenge).toHaveLength(1);
  });

  test("Speichern scheitert am Netz: Bauen startet nicht, nichts geht verloren", async () => {
    const server = fakeServer();
    const { p, saver } = page(server);
    const original = server.request;
    let down = true;
    const flaky = (method: string, path: string, body?: any) => (down ? Promise.reject(new Error("Netz weg")) : original(method, path, body));
    const s2 = w.vaWizardSaver({ kennung: "test", revision: 1, request: flaky, upload: server.upload, fields: () => p.felder, dirty: () => [...p.dirty], schritt: () => 5, debounceMs: 1, onState: (text: string, error: boolean) => p.messages.push({ text, error }) });
    p.felder = w.vaWizardSet(p.felder, "name", "Neu");
    const res = await s2.build();
    expect(res.status).toBe(0);
    expect(res.body.error).toBe(w.VA_WIZARD_TEXT.saveFailed);
    expect(p.messages.at(-1)).toEqual({ text: w.VA_WIZARD_TEXT.saveFailed, error: true });
    expect(server.calls.filter((c) => c.path.endsWith("/bauen"))).toHaveLength(0);
    down = false;
    expect((await s2.build()).status).toBe(202);
    expect(server.state.felder.name).toBe("Neu");
    void saver;
  });
});

// Prüfung von PR #558
describe("Aus-Werte, unfertige Eingaben und Satz", () => {
  test("Schalter, die die Seite als aus zeigt, gehen ausdrücklich als false mit; angehakte als true", () => {
    expect(w.vaWizardSendFields({ vorlage: "jarvis" })).toMatchObject({ zugang: { web: false }, gehirn: { denkauftrag: false } });
    const on = w.vaWizardSendFields({ vorlage: "jarvis", zugang: { web: true }, gehirn: { denkauftrag: true, modell: "m" } });
    expect(on.zugang).toEqual({ web: true });
    expect(on.gehirn).toEqual({ denkauftrag: true, modell: "m" });
  });

  test("halber Link und Telefon ohne Nummer: nicht in felder, aber in offen; zurück auf der Seite wie getippt", () => {
    const felder = { vorlage: "experte", links: ["https://example.org", "https://", " "], zugang: { web: true, telefon: { nummer: "", anrufer: "freigegeben", pin: false } } };
    const body = w.vaWizardPutBody(felder, undefined, { revision: 3 });
    expect(body.revision).toBe(3);
    expect(body.felder.links).toEqual(["https://example.org"]);
    expect(body.felder.zugang).toEqual({ web: true });
    expect(body.offen).toEqual({ links: ["https://example.org", "https://"], telefon: { nummer: "", anrufer: "freigegeben", pin: false } });
    const back = w.vaWizardFromView({ felder: body.felder, offen: body.offen });
    expect(back.links).toEqual(["https://example.org", "https://"]);
    expect(back.zugang.telefon).toEqual({ nummer: "", anrufer: "freigegeben", pin: false });
    // Alles gültig: nichts offen
    expect(w.vaWizardOpenInputs({ links: ["https://example.org"], zugang: { telefon: { nummer: "nr_1", anrufer: "alle" } } })).toBeUndefined();
    expect(w.vaWizardWithOpen({ name: "N" }, undefined)).toEqual({ name: "N" });
  });

  test("Satz geht mit jedem Speichern mit, auch leer; onSaved meldet den gesendeten Satz", async () => {
    const server = fakeServer();
    let satz = "Erster";
    const seen: (string | undefined)[] = [];
    const saver = w.vaWizardSaver({ kennung: "test", revision: 1, request: server.request, upload: server.upload, fields: () => ({ vorlage: "jarvis" }), satz: () => satz, dirty: () => [], schritt: () => 1, onSaved: (_v: any, _p: any, _s: any, sent: string) => seen.push(sent) });
    await saver.flush();
    satz = "";
    await saver.flush();
    expect(server.calls.filter((c) => c.method === "PUT").map((c) => c.body.satz)).toEqual(["Erster", ""]);
    expect(seen).toEqual(["Erster", ""]);
  });

  test("409 veraltet: unfertige Eingaben des Servers bleiben, eigene liegen darüber", async () => {
    const server = fakeServer();
    // Anderswo gespeichert: revision weiter, ein halber Link offen
    server.state.revision = 2;
    const original = server.request;
    const calls: any[] = [];
    const request = async (method: string, path: string, body?: any) => {
      calls.push({ method, body });
      if (method === "GET") return { status: 200, body: { revision: 2, felder: { vorlage: "experte", name: "B" }, offen: { links: ["www.halb"] }, phase: "wizard" } };
      return original(method, path, body);
    };
    const s2 = w.vaWizardSaver({ kennung: "test", revision: 1, request, upload: server.upload, fields: () => ({ vorlage: "experte", name: "A" }), dirty: () => ["name"], schritt: () => 3 });
    expect(await s2.flush()).toEqual({ ok: true });
    const last = calls.filter((c) => c.method === "PUT").at(-1).body;
    expect(last.felder.name).toBe("A");
    expect(last.offen).toEqual({ links: ["www.halb"] });
  });
});
